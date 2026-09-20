const mineflayer = require('mineflayer');
const express = require('express');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow } = goals;

// --- Web Server (24/7 Hosting ke liye) ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Smart Girl AI Bot is Online!'));
app.listen(port, () => console.log(`Web server listening on port ${port}`));

// --- Configuration ---
const SERVER_IP = 'YSsmpontop.aternos.me';
const BOT_USERNAME = 'Cassie';                 // Bot ka username
const VERSION = '1.20.4';
const GIRL_SKIN_NAME = 'chloepowell';           // Default girl skin (SkinsRestorer ke liye)
const OWNER_USERNAME = 'NotGamerSpark'; // Apna exact Minecraft IGN yahan daalo
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'YOUR_OPENROUTER_API_KEY';
const MODEL_NAME = 'openai/gpt-4o-mini';

let afkInterval = null;

function startBot() {
  console.log(`Connecting to ${SERVER_IP}...`);

  const bot = mineflayer.createBot({
    host: SERVER_IP,
    username: BOT_USERNAME,
    version: VERSION
  });

  bot.loadPlugin(pathfinder);

  // 1. Spawn Event (Skin Setup, Pathfinder Config & AFK Loop)
  bot.on('spawn', () => {
    console.log(`✅ ${bot.username} spawned successfully!`);

    // Pathfinder Safety Configuration (Lava & Fall damage se bachne ke liye)
    const mcData = require('minecraft-data')(bot.version);
    const defaultMove = new Movements(bot, mcData);
    defaultMove.canDig = false;          // Apne niche ka block tod kar na gire
    defaultMove.allow1by1towers = false; // Faltu tower na banaye
    defaultMove.maxDropDown = 3;         // 3 blocks se zyada unchi jagah se na kude
    defaultMove.liquidCost = 50;         // Lava/paani ko avoid kare
    bot.pathfinder.setMovements(defaultMove);

    // Auto Girl Skin lagana (3 seconds baad)
    setTimeout(() => {
      bot.chat(`/skin ${GIRL_SKIN_NAME}`);
    }, 3000);

    // Safe Anti-AFK Human movement shuru karein
    startSafeAfkMovement(bot);
  });

  // 2. Auto-Respawn on Death
  bot.on('death', () => {
    console.log('💀 Bot mar gaya! 2 seconds me respawn ho raha hai...');
    setTimeout(() => {
      bot.respawn();
    }, 2000);
  });

  // 3. Danger Detection: Hostile Mobs (Creepers/Zombies) se bachna
  bot.on('entityMoved', (entity) => {
    if (!['creeper', 'zombie', 'skeleton', 'spider'].includes(entity.name)) return;

    const distance = bot.entity.position.distanceTo(entity.position);

    // Agar mob 5 block ke andar aa jaye
    if (distance < 5) {
      if (entity.name === 'creeper') {
        // Creeper dekhte hi ulti disha me bhaage
        const awayVec = bot.entity.position.minus(entity.position).normalize();
        bot.lookAt(bot.entity.position.plus(awayVec));
        bot.setControlState('sprint', true);
        bot.setControlState('forward', true);
        setTimeout(() => bot.clearControlStates(), 1500);
      } else {
        // Zombie/Skeleton par attack swing kare
        bot.lookAt(entity.position.offset(0, 1.5, 0));
        bot.attack(entity);
      }
    }
  });

  // 4. Chat Commands & AI Brain
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    const cleanMsg = message.trim();

    // Owner Direct Command Execution (e.g., !cmd /skin Valkyrae ya !cmd /tp)
    if (username === OWNER_USERNAME && cleanMsg.startsWith('!cmd ')) {
      const runCommand = cleanMsg.replace('!cmd ', '').trim();
      console.log(`[Admin Command] Running: ${runCommand}`);
      bot.chat(runCommand);
      return;
    }

    // AI Trigger Check
    const isBotMentioned = cleanMsg.toLowerCase().includes(bot.username.toLowerCase()) || cleanMsg.startsWith('!');
    if (!isBotMentioned) return;

    try {
      await handleOpenRouterChat(bot, username, cleanMsg);
    } catch (err) {
      console.error('AI Chat Error:', err.message);
      bot.chat(`@${username} Mera dimag thoda lag kar gaya, dobara bolna?`);
    }
  });

  // 5. Safe Reconnect & Cleanup
  bot.on('kicked', (reason) => console.log(`⚠️ Kicked: ${reason}`));
  bot.on('end', () => {
    console.log('🔴 Disconnected. 30 seconds baad reconnect karega...');
    if (afkInterval) clearInterval(afkInterval);
    setTimeout(startBot, 30000);
  });

  bot.on('error', (err) => console.error(`❌ Bot Error: ${err.message}`));
}

// --- OpenRouter AI Handler ---
async function handleOpenRouterChat(bot, username, userMessage) {
  const botPos = bot.entity.position;
  const systemPrompt = `
You are a smart, friendly female Minecraft companion named ${bot.username}.
You play on a survival SMP. You speak natural, cool Hinglish (Hindi + English).
Keep your chat responses short (under 80 characters) so they fit nicely in Minecraft chat.

Current Stats:
- Health: ${Math.round(bot.health)}/20 | Food: ${Math.round(bot.food)}/20
- Coordinates: X=${Math.round(botPos.x)}, Y=${Math.round(botPos.y)}, Z=${Math.round(botPos.z)}
- Talking to: ${username}

If the user gives you a game command, add a JSON tag at the VERY END:
- Follow player: [[ACTION: {"type": "follow", "target": "${username}"}]]
- Stop moving: [[ACTION: {"type": "stop"}]]
- Run any server command: [[ACTION: {"type": "cmd", "cmd": "/skin <name>"}]]
- Jump: [[ACTION: {"type": "jump"}]]

Example response:
"Haan bro bol, tere paas aa rahi hu! [[ACTION: {"type": "follow", "target": "${username}"}]]"
`;

  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: MODEL_NAME,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${username}: ${userMessage}` }
      ],
      max_tokens: 120,
      temperature: 0.7
    },
    {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://minecraft-smp.local',
        'X-Title': 'Minecraft AI Companion'
      }
    }
  );

  const rawReply = response.data.choices[0].message.content.trim();
  const actionMatch = rawReply.match(/\[\[ACTION:\s*(\{.*?\})\]\]/);
  let chatText = rawReply.replace(/\[\[ACTION:\s*(\{.*?\})\]\]/, '').trim();

  if (chatText) {
    if (chatText.length > 200) chatText = chatText.substring(0, 197) + '...';
    bot.chat(chatText);
  }

  if (actionMatch) {
    try {
      const action = JSON.parse(actionMatch[1]);
      executeBotAction(bot, action, username);
    } catch (e) {
      console.error('Failed to parse AI action:', e);
    }
  }
}

// --- Action Execution Function ---
function executeBotAction(bot, action, defaultTarget) {
  const targetName = action.target || defaultTarget;
  const targetPlayer = bot.players[targetName]?.entity;

  switch (action.type) {
    case 'follow':
      if (targetPlayer) {
        bot.pathfinder.setGoal(new GoalFollow(targetPlayer, 2), true);
      } else {
        bot.chat(`Tu mujhe dikh nahi raha ${targetName}, thoda paas aa!`);
      }
      break;

    case 'stop':
      bot.pathfinder.stop();
      bot.clearControlStates();
      break;

    case 'cmd':
      if (action.cmd) bot.chat(action.cmd);
      break;

    case 'jump':
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 400);
      break;
  }
}

// --- Lava & Fall Safe Anti-AFK Movement ---
function startSafeAfkMovement(bot) {
  if (afkInterval) clearInterval(afkInterval);

  afkInterval = setInterval(() => {
    // Agar bot already player ko follow kar raha hai to beech me disturb na kare
    if (bot.pathfinder.isMoving()) return;

    // Check kare ki niche lava ya khali jagah to nahi hai
    const blockBelow = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!blockBelow || blockBelow.name === 'lava' || blockBelow.name === 'flowing_lava') {
      bot.setControlState('jump', true);
      return;
    }

    // Safe random direction movement (safe button tap)
    const moves = ['forward', 'back', 'left', 'right', 'sneak'];
    const randomMove = moves[Math.floor(Math.random() * moves.length)];
    bot.setControlState(randomMove, true);

    // Natural camera look
    const yaw = Math.random() * Math.PI * 2;
    const pitch = (Math.random() - 0.5) * 0.6;
    bot.look(yaw, pitch, false);

    if (Math.random() > 0.5) bot.swingArm('right');

    setTimeout(() => {
      bot.clearControlStates();
    }, 500 + Math.random() * 800);

  }, 9000 + Math.random() * 5000);
}

startBot();
