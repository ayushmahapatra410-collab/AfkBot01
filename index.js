const mineflayer = require('mineflayer');
const express = require('express');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow } = goals;

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Cassie is Online!'));
app.listen(port, () => console.log(`Listening on port ${port}`));

// --- Config ---
const SERVER_IP = 'YSsmpontop.aternos.me';
const BOT_USERNAME = 'Cassie';
const VERSION = '1.20.4';
const DEFAULT_SKIN = 'chloepowell';
const OWNER_USERNAME = 'NotGamerSpark'; // Screenshot ke according tera IGN set kar diya
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL_NAME = 'openai/gpt-4o-mini';

let afkInterval = null;
let currentFollowTarget = null;
// Memory buffer (Last 6 messages yaad rakhegi)
let chatMemory = [];

function startBot() {
  console.log(`Connecting Cassie to ${SERVER_IP}...`);

  const bot = mineflayer.createBot({
    host: SERVER_IP,
    username: BOT_USERNAME,
    version: VERSION
  });

  bot.loadPlugin(pathfinder);

  bot.on('spawn', () => {
    console.log(`✅ ${bot.username} spawned!`);
    const mcData = require('minecraft-data')(bot.version);
    const defaultMove = new Movements(bot, mcData);
    defaultMove.canDig = true; // Mining allow ki
    defaultMove.allow1by1towers = false;
    defaultMove.maxDropDown = 4;
    defaultMove.allowParkour = true;
    bot.pathfinder.setMovements(defaultMove);

    setTimeout(() => bot.chat(`/skin ${DEFAULT_SKIN}`), 3000);
    startSafeAfk(bot);
  });

  bot.on('death', () => {
    console.log('💀 Respawning...');
    currentFollowTarget = null;
    setTimeout(() => bot.respawn(), 2000);
  });

  // Chat Router
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    const cleanMsg = message.trim();

    // Owner direct command
    if (cleanMsg.startsWith('!cmd ')) {
      if (username !== OWNER_USERNAME) {
        bot.chat(`@${username} Sirf owner (${OWNER_USERNAME}) commands chala sakte hain!`);
        return;
      }
      bot.chat(cleanMsg.replace('!cmd ', '').trim());
      return;
    }

    // Owner stop shortcut
    if (username === OWNER_USERNAME && (cleanMsg === '!stop' || cleanMsg.toLowerCase() === '!cassie stop')) {
      stopFollowing(bot, 'Ruk gayi!');
      return;
    }

    // Chat prefix rule
    if (!cleanMsg.startsWith('!')) return;
    const query = cleanMsg.substring(1).trim();
    if (!query) return;

    try {
      await handleCassieAI(bot, username, query);
    } catch (err) {
      console.error('AI Error:', err.message);
      bot.chat(`@${username} Dimag thoda lag ho gaya, wapas bolna!`);
    }
  });

  // Mobs check
  setInterval(() => {
    if (bot.pathfinder.isMoving()) return;
    const mob = bot.nearestEntity(e => 
      ['creeper', 'zombie', 'skeleton'].includes(e.name) &&
      bot.entity.position.distanceTo(e.position) < 5
    );
    if (mob) {
      if (mob.name === 'creeper') {
        const away = bot.entity.position.minus(mob.position).normalize();
        bot.lookAt(bot.entity.position.plus(away));
        bot.setControlState('sprint', true);
        bot.setControlState('forward', true);
        setTimeout(() => bot.clearControlStates(), 1200);
      } else {
        bot.attack(mob);
      }
    }
  }, 2000);

  bot.on('end', () => {
    console.log('Disconnected. Reconnecting in 25s...');
    if (afkInterval) clearInterval(afkInterval);
    currentFollowTarget = null;
    setTimeout(startBot, 25000);
  });

  bot.on('error', (e) => console.error(e.message));
}

// --- AI Brain with Memory & Actions ---
async function handleCassieAI(bot, sender, userPrompt) {
  const isOwner = sender === OWNER_USERNAME;
  const botPos = bot.entity.position;

  // Samne kaun sa block hai check karna
  const targetBlock = bot.blockAtCursor(4);
  const blockInFrontName = targetBlock ? targetBlock.name : 'air';

  const systemPrompt = `
You are Cassie, an active human-like female Minecraft player on an SMP.
NEVER talk like a robotic assistant. Do NOT say "Help karne ko ready hoon" or "dhyan do". Talk like a real gamer girl friend in casual Hinglish.
Keep responses under 60 characters.

Status:
- Talking to: ${sender} (Owner: ${isOwner})
- Block right in front/crosshair: "${blockInFrontName}"
- Health: ${Math.round(bot.health)}/20
- Currently Following: ${currentFollowTarget || 'None'}

Actions (Append JSON tag at the VERY END if action is asked):
- Follow sender: [[ACTION: {"type": "follow", "target": "${sender}"}]]
${isOwner ? `- Follow another player: [[ACTION: {"type": "follow", "target": "<player>"}]]` : ''}
- Stop moving: [[ACTION: {"type": "stop"}]]
- Mine block in front: [[ACTION: {"type": "mine"}]]
- Run server command: [[ACTION: {"type": "cmd", "cmd": "/command"}]]
`;

  // Memory maintain (Last 6 messages)
  chatMemory.push({ role: 'user', content: `${sender}: ${userPrompt}` });
  if (chatMemory.length > 6) chatMemory.shift();

  const messagesPayload = [
    { role: 'system', content: systemPrompt },
    ...chatMemory
  ];

  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: MODEL_NAME,
      messages: messagesPayload,
      max_tokens: 100,
      temperature: 0.6
    },
    {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const rawReply = response.data.choices[0].message.content.trim();
  const actionMatch = rawReply.match(/\[\[ACTION:\s*(\{.*?\})\]\]/);
  let chatText = rawReply.replace(/\[\[ACTION:\s*(\{.*?\})\]\]/, '').trim();

  // Assistant response ko bhi memory me save karo
  chatMemory.push({ role: 'assistant', content: chatText });

  if (chatText) {
    if (chatText.length > 200) chatText = chatText.substring(0, 197) + '...';
    bot.chat(chatText);
  }

  if (actionMatch) {
    try {
      const action = JSON.parse(actionMatch[1]);
      executeAction(bot, sender, isOwner, action);
    } catch (e) {
      console.error('Parse err:', e);
    }
  }
}

// --- Action Handler ---
async function executeAction(bot, sender, isOwner, action) {
  switch (action.type) {
    case 'follow': {
      let targetName = action.target || sender;
      if (!isOwner && targetName.toLowerCase() !== sender.toLowerCase()) targetName = sender;

      const player = bot.players[targetName]?.entity;
      if (player) {
        currentFollowTarget = targetName;
        bot.pathfinder.setGoal(new GoalFollow(player, 2), true);
      } else {
        bot.chat(`@${sender} tu render range ke bahar hai, paas aa!`);
      }
      break;
    }

    case 'mine': {
      const block = bot.blockAtCursor(4);
      if (block && block.name !== 'air' && block.name !== 'bedrock') {
        try {
          await bot.dig(block);
          bot.chat(`Tod diya ${block.name}!`);
        } catch (err) {
          bot.chat(`Block toot nahi paya: ${err.message}`);
        }
      } else {
        bot.chat(`Samne koi todne layak block nahi hai!`);
      }
      break;
    }

    case 'stop': {
      if (isOwner || currentFollowTarget === sender) {
        stopFollowing(bot, 'Ruk gayi!');
      }
      break;
    }

    case 'cmd': {
      if (isOwner && action.cmd) bot.chat(action.cmd);
      break;
    }
  }
}

function stopFollowing(bot, msg) {
  currentFollowTarget = null;
  bot.pathfinder.stop();
  bot.clearControlStates();
  if (msg) bot.chat(msg);
}

function startSafeAfk(bot) {
  if (afkInterval) clearInterval(afkInterval);
  afkInterval = setInterval(() => {
    if (bot.pathfinder.isMoving() || currentFollowTarget) return;
    bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.4, false);
    if (Math.random() > 0.5) bot.swingArm('right');
  }, 10000);
}

startBot();
