const mineflayer = require('mineflayer');
const express = require('express');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow, GoalNear, GoalXZ } = goals;

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Cassie Pro Player is Online!'));
app.listen(port, () => console.log(`Web server running on port ${port}`));

// --- Configurations ---
const SERVER_IP = 'YSsmpontop.aternos.me';
const BOT_USERNAME = 'Cassie';
const VERSION = '1.20.4';
const DEFAULT_SKIN = 'chloepowell';

// 2 Owners set karein yahan
const OWNERS = ['NotGamerSpark', 'DusraOwnerUsername'].map(o => o.toLowerCase());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL_NAME = 'openai/gpt-4o-mini';

let afkInterval = null;
let currentFollowTarget = null;
let isExploring = false;
let isSafeMode = true; // Safe play flag

// Game and Conversation Long-Term Memory Buffer
let chatMemory = [];
let gameEventsLog = [];

function logGameEvent(event) {
  gameEventsLog.push(`[${new Date().toLocaleTimeString()}] ${event}`);
  if (gameEventsLog.length > 10) gameEventsLog.shift();
}

function isOwner(username) {
  return username && OWNERS.includes(username.toLowerCase());
}

function startBot() {
  console.log(`Connecting Cassie Pro to ${SERVER_IP}...`);

  const bot = mineflayer.createBot({
    host: SERVER_IP,
    username: BOT_USERNAME,
    version: VERSION
  });

  bot.loadPlugin(pathfinder);

  bot.on('spawn', () => {
    console.log(`✅ ${bot.username} spawned like a Pro!`);
    const mcData = require('minecraft-data')(bot.version);
    const defaultMove = new Movements(bot, mcData);

    // PRO MOVEMENT: Todne ke bajaye climb & jump kare
    defaultMove.canDig = false;          // Raste ke blocks bilkul nahi todegi
    defaultMove.allowParkour = true;     // 1-2 block parkour & jump over slabs
    defaultMove.allowSprinting = true;   // Sprint karegi insaan ki tarah
    defaultMove.maxDropDown = 4;
    defaultMove.liquidCost = 25;
    bot.pathfinder.setMovements(defaultMove);

    setTimeout(() => bot.chat(`/skin ${DEFAULT_SKIN}`), 3000);
    logGameEvent('Server me join hui aur setup complete kiya');
    startSafeAfk(bot);
  });

  bot.on('death', () => {
    logGameEvent('Mar gayi aur respawn ho rahi hai');
    currentFollowTarget = null;
    isExploring = false;
    setTimeout(() => bot.respawn(), 2000);
  });

  // Self Defense & PVP (Attacked hone par)
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;

    // Aas paas attacker dhundo
    const attacker = bot.nearestEntity(e => 
      (e.type === 'mob' || (e.type === 'player' && !isOwner(e.username))) &&
      bot.entity.position.distanceTo(e.position) < 6
    );

    if (attacker) {
      logGameEvent(`${attacker.name || attacker.username} ne damage diya! Counter attack shuru.`);
      proAttack(bot, attacker);
    }
  });

  // Chat Router
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    const cleanMsg = message.trim();

    // Owner Direct Command Execution (!cmd <cmd>)
    if (cleanMsg.startsWith('!cmd ')) {
      if (!isOwner(username)) {
        bot.chat(`@${username} Sirf owners command chala sakte hain!`);
        return;
      }
      bot.chat(cleanMsg.replace('!cmd ', '').trim());
      return;
    }

    // Owner Stop Override
    if (isOwner(username) && (cleanMsg === '!stop' || cleanMsg.toLowerCase() === '!cassie stop')) {
      stopAll(bot, 'Ruk gayi, sab cancel!');
      return;
    }

    // Only respond with '!' prefix
    if (!cleanMsg.startsWith('!')) return;
    const query = cleanMsg.substring(1).trim();
    if (!query) return;

    try {
      await handleCassieAI(bot, username, query);
    } catch (err) {
      console.error('AI Error:', err.message);
      bot.chat(`@${username} Lag ho gayi thodi, dobara bol!`);
    }
  });

  // Auto Combat & Defense Loop
  setInterval(() => {
    if (bot.pathfinder.isMoving() && !isExploring) return;

    // 4 block ke andar dangerous mob check karein
    const dangerMob = bot.nearestEntity(e => 
      ['creeper', 'zombie', 'skeleton', 'spider'].includes(e.name) &&
      bot.entity.position.distanceTo(e.position) < 5
    );

    if (dangerMob) {
      if (dangerMob.name === 'creeper') {
        // Creeper se sprint back
        const away = bot.entity.position.minus(dangerMob.position).normalize();
        bot.lookAt(bot.entity.position.plus(away));
        bot.setControlState('sprint', true);
        bot.setControlState('forward', true);
        setTimeout(() => bot.clearControlStates(), 1000);
      } else {
        proAttack(bot, dangerMob);
      }
    }
  }, 1200);

  bot.on('end', () => {
    console.log('Disconnected. Reconnecting...');
    if (afkInterval) clearInterval(afkInterval);
    currentFollowTarget = null;
    isExploring = false;
    setTimeout(startBot, 25000);
  });

  bot.on('error', (e) => console.error(e.message));
}

// --- Pro Combat Execution (Sword Equip + Crit Hit) ---
async function proAttack(bot, target) {
  if (isOwner(target.username)) return; // Owner par attack bilkul nahi

  // Best sword ya axe hath me pakadna
  const weapon = bot.inventory.items().find(i => i.name.includes('sword') || i.name.includes('axe'));
  if (weapon) {
    try { await bot.equip(weapon, 'hand'); } catch (e) {}
  }

  bot.lookAt(target.position.offset(0, target.height * 0.8, 0));

  // Critical hit: Jump karke niche aate waqt attack
  bot.setControlState('jump', true);
  setTimeout(() => {
    bot.setControlState('jump', false);
    bot.attack(target);
  }, 250);
}

// --- AI Brain with Full Memory & Smart Decision ---
async function handleCassieAI(bot, sender, userPrompt) {
  const senderIsOwner = isOwner(sender);
  const botPos = bot.entity.position;

  // Inventory list text
  const invItems = bot.inventory.items().map(i => `${i.name} (x${i.count})`).join(', ') || 'Khali hai';

  const systemPrompt = `
You are Cassie, a pro human Minecraft player on an SMP.
You play smartly like an actual gamer with full consciousness. Never act like a robotic AI assistant.
Speak in cool, friendly, casual gamer Hinglish. Max 75 characters per response.

Game Context & Memory:
- Sender: ${sender} (Is Owner: ${senderIsOwner})
- Your Pos: X=${Math.round(botPos.x)}, Y=${Math.round(botPos.y)}, Z=${Math.round(botPos.z)}
- Health: ${Math.round(bot.health)}/20 | Food: ${Math.round(bot.food)}/20
- Inventory: [${invItems}]
- Recent Events: ${gameEventsLog.slice(-3).join(' | ')}
- Mode: ${isExploring ? 'Exploring' : currentFollowTarget ? `Following ${currentFollowTarget}` : 'Idle'}

Action Commands (Add JSON tag at the VERY END only if an action is needed):
- Follow someone: [[ACTION: {"type": "follow", "target": "${sender}"}]]
${senderIsOwner ? `- Follow specific player: [[ACTION: {"type": "follow", "target": "<player>"}]]` : ''}
- Stop everything: [[ACTION: {"type": "stop"}]]
- Explore autonomously: [[ACTION: {"type": "explore"}]]
- Drop item: [[ACTION: {"type": "drop", "item": "<item_name_or_all>"}]]
- Toggle safe mode: [[ACTION: {"type": "safe_mode", "value": true}]]
- Run command: [[ACTION: {"type": "cmd", "cmd": "/command"}]]

If sender says "drop sword", action is {"type": "drop", "item": "sword"}.
If asked to explore, action is {"type": "explore"}.
`;

  // Memory buffer maintain
  chatMemory.push({ role: 'user', content: `${sender}: ${userPrompt}` });
  if (chatMemory.length > 8) chatMemory.shift();

  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: MODEL_NAME,
      messages: [{ role: 'system', content: systemPrompt }, ...chatMemory],
      max_tokens: 120,
      temperature: 0.65
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

  chatMemory.push({ role: 'assistant', content: chatText });

  if (chatText) {
    if (chatText.length > 200) chatText = chatText.substring(0, 197) + '...';
    bot.chat(chatText);
  }

  if (actionMatch) {
    try {
      const action = JSON.parse(actionMatch[1]);
      executeAction(bot, sender, senderIsOwner, action);
    } catch (e) {
      console.error('Action parse error:', e);
    }
  }
}

// --- Action Execution ---
async function executeAction(bot, sender, senderIsOwner, action) {
  switch (action.type) {
    case 'follow': {
      isExploring = false;
      let targetName = action.target || sender;
      if (!senderIsOwner && targetName.toLowerCase() !== sender.toLowerCase()) targetName = sender;

      const player = bot.players[targetName]?.entity;
      if (player) {
        currentFollowTarget = targetName;
        bot.pathfinder.setGoal(new GoalFollow(player, 2), true);
        logGameEvent(`${targetName} ko follow karna shuru kiya`);
      } else {
        bot.chat(`@${sender} tu render range ke bahar hai, paas aa!`);
      }
      break;
    }

    case 'explore': {
      currentFollowTarget = null;
      isExploring = true;
      bot.chat('Theek hai, main thoda explore karke aati hu!');
      logGameEvent('Autonomous explore mode shuru kiya');
      runExploreCycle(bot);
      break;
    }

    case 'drop': {
      const itemToDrop = action.item ? action.item.toLowerCase() : 'all';
      dropItemsFromInventory(bot, itemToDrop);
      break;
    }

    case 'safe_mode': {
      isSafeMode = Boolean(action.value);
      bot.chat(isSafeMode ? 'Ab se ekdam safe play karungi!' : 'Aggressive mode on!');
      break;
    }

    case 'stop': {
      if (senderIsOwner || currentFollowTarget === sender) {
        stopAll(bot, 'Ruk gayi!');
      }
      break;
    }

    case 'cmd': {
      if (senderIsOwner && action.cmd) bot.chat(action.cmd);
      break;
    }
  }
}

// --- Explore Cycle (Insan ki tarah ghume) ---
function runExploreCycle(bot) {
  if (!isExploring) return;

  const currentPos = bot.entity.position;
  // 15-25 blocks door random point
  const rx = currentPos.x + (Math.random() - 0.5) * 35;
  const rz = currentPos.z + (Math.random() - 0.5) * 35;

  bot.pathfinder.setGoal(new GoalXZ(rx, rz));

  // Agar 12 sec me na pahuche toh agla target
  setTimeout(() => {
    if (isExploring) runExploreCycle(bot);
  }, 12000);
}

// --- Drop Items Function ---
async function dropItemsFromInventory(bot, matchName) {
  const items = bot.inventory.items();
  if (items.length === 0) {
    bot.chat('Mera inventory khali hai!');
    return;
  }

  for (const item of items) {
    if (matchName === 'all' || matchName === 'everything' || item.name.toLowerCase().includes(matchName)) {
      try {
        await bot.tossStack(item);
      } catch (err) {
        console.error('Drop error:', err);
      }
    }
  }
  bot.chat('Le phek diya!');
}

function stopAll(bot, msg) {
  currentFollowTarget = null;
  isExploring = false;
  bot.pathfinder.stop();
  bot.clearControlStates();
  if (msg) bot.chat(msg);
}

function startSafeAfk(bot) {
  if (afkInterval) clearInterval(afkInterval);
  afkInterval = setInterval(() => {
    if (bot.pathfinder.isMoving() || currentFollowTarget || isExploring) return;
    bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.4, false);
    if (Math.random() > 0.5) bot.swingArm('right');
  }, 8000);
}

startBot();
