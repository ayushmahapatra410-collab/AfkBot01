const mineflayer = require('mineflayer');
const express = require('express');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow, GoalXZ } = goals;

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Cassie Pro is Running!'));
app.listen(port, () => console.log(`Listening on port ${port}`));

// --- Configurations ---
const SERVER_IP = 'YSsmpontop.aternos.me';
const BOT_USERNAME = 'Cassie';
const VERSION = '1.20.4';
const DEFAULT_SKIN = 'chloepowell';

// Dono Owners yahan daal do
const OWNERS = ['NotGamerSpark', 'DusraOwnerUsername'].map(o => o.toLowerCase());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL_NAME = 'openai/gpt-6-astra';

let afkInterval = null;
let currentFollowTarget = null;
let isExploring = false;
let isReconnecting = false;

// Memory Buffer
let chatMemory = [];
let gameEventsLog = [];

function isOwner(username) {
  return username && OWNERS.includes(username.toLowerCase());
}

function logGameEvent(event) {
  gameEventsLog.push(`[${new Date().toLocaleTimeString()}] ${event}`);
  if (gameEventsLog.length > 8) gameEventsLog.shift();
}

function startBot() {
  console.log(`Connecting Cassie to ${SERVER_IP}...`);
  isReconnecting = false;

  const bot = mineflayer.createBot({
    host: SERVER_IP,
    username: BOT_USERNAME,
    version: VERSION
  });

  bot.loadPlugin(pathfinder);

  bot.on('spawn', () => {
    console.log(`✅ ${bot.username} spawned!`);
    try {
      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);

      // Stable movement settings
      defaultMove.canDig = false;           
      defaultMove.allowParkour = true;      
      defaultMove.allowSprinting = true;    
      defaultMove.canOpenDoors = true;      
      defaultMove.maxDropDown = 4;          
      defaultMove.liquidCost = 25;
      defaultMove.entityCost = 0; // Player hitbox collision bypass[cite: 3]

      bot.pathfinder.setMovements(defaultMove);
    } catch (e) {
      console.error('Movement init error:', e.message);
    }

    setTimeout(() => bot.chat(`/skin ${DEFAULT_SKIN}`), 3000);
    startSafeAfk(bot);
  });

  bot.on('death', () => {
    logGameEvent('Mar gayi!');
    stopAll(bot);
    setTimeout(() => {
      try { bot.respawn(); } catch (e) {}
    }, 2000);
  });

  // SLAB & STEP AUTO JUMP (Sirf obstruction par tap karega, direct forward fight nahi karega)
  bot.on('physicsTick', () => {
    if (!currentFollowTarget && !isExploring) return;

    // Agar pathfinder chal raha hai aur samne slab ya 1 block aa gaya to jump tap kare
    if (bot.entity.isCollidedHorizontally) {
      bot.setControlState('jump', true);
    } else {
      bot.setControlState('jump', false);
    }
  });

  // Pathfinder stuck hone par safe recover
  bot.on('path_reset', (reason) => {
    if (currentFollowTarget && reason === 'noPath') {
      const target = bot.players[currentFollowTarget]?.entity;
      if (!target) {
        bot.chat(`@${currentFollowTarget} Rasta nahi mil raha, paas aao!`);
        currentFollowTarget = null;
        bot.pathfinder.stop();
      }
    }
  });

  // Self Defense (Attackers par critical hits)
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    const attacker = bot.nearestEntity(e => 
      (e.type === 'mob' || (e.type === 'player' && !isOwner(e.username))) &&
      bot.entity.position.distanceTo(e.position) < 5
    );
    if (attacker) proAttack(bot, attacker);
  });

  // Chat Router
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    const cleanMsg = message.trim();

    // Owner Console Command (!cmd <command>)
    if (cleanMsg.startsWith('!cmd ')) {
      if (!isOwner(username)) {
        bot.chat(`@${username} Sirf owner console commands chala sakte hain!`);
        return;
      }
      bot.chat(cleanMsg.replace('!cmd ', '').trim());
      return;
    }

    // Owner Stop Override
    if (cleanMsg === '!stop' || cleanMsg.toLowerCase() === '!cassie stop') {
      if (isOwner(username) || currentFollowTarget === username) {
        stopAll(bot, 'Ruk gayi, sab cancel!');
      }
      return;
    }

    // Chat Prefix '!'
    if (!cleanMsg.startsWith('!')) return;
    const query = cleanMsg.substring(1).trim().toLowerCase();
    if (!query) return;

    // INSTANT FOLLOW SHORTCUT (AI ka wait kiye bina direct execution taaki lag se disconnect na ho)
    if (query.includes('pass aa') || query.includes('follow') || query.includes('aaja') || query.includes('mere pass')) {
      isExploring = false;
      const player = bot.players[username]?.entity;
      if (player) {
        currentFollowTarget = username;
        bot.pathfinder.setGoal(new GoalFollow(player, 2.2), true);
        bot.chat(`Aa rahi hu @${username}!`);
      } else {
        bot.chat(`@${username} Tu render range me nahi hai, thoda samne aa!`);
      }
      return;
    }

    try {
      await handleCassieAI(bot, username, cleanMsg.substring(1).trim());
    } catch (err) {
      console.error('AI Error:', err.response?.data || err.message);
      bot.chat(`@${username} Mera dimag lag ho gaya, dobara bolna!`);
    }
  });

  // Auto Mob Combat Loop
  setInterval(() => {
    if (bot.pathfinder.isMoving() && !isExploring) return;
    const dangerMob = bot.nearestEntity(e => 
      ['creeper', 'zombie', 'skeleton', 'spider'].includes(e.name) &&
      bot.entity.position.distanceTo(e.position) < 4.5
    );

    if (dangerMob) {
      if (dangerMob.name === 'creeper') {
        const away = bot.entity.position.minus(dangerMob.position).normalize();
        bot.lookAt(bot.entity.position.plus(away));
        bot.setControlState('sprint', true);
        bot.setControlState('forward', true);
        setTimeout(() => bot.clearControlStates(), 1200);
      } else {
        proAttack(bot, dangerMob);
      }
    }
  }, 1400);

  bot.on('kicked', (reason) => console.log(`[Kicked from Aternos]: ${reason}`));

  bot.on('end', () => {
    if (isReconnecting) return;
    isReconnecting = true;
    console.log('🔴 Disconnected. Waiting 25s before reconnecting...');
    if (afkInterval) clearInterval(afkInterval);
    stopAll(bot);
    setTimeout(startBot, 25000);
  });

  bot.on('error', (e) => console.error('[Bot Error]:', e.message));
}

// --- Critical Hit Combat ---
async function proAttack(bot, target) {
  if (isOwner(target.username)) return;

  const weapon = bot.inventory.items().find(i => i.name.includes('sword') || i.name.includes('axe'));
  if (weapon) {
    try { await bot.equip(weapon, 'hand'); } catch (e) {}
  }

  bot.lookAt(target.position.offset(0, target.height * 0.8, 0));
  bot.setControlState('jump', true);
  setTimeout(() => {
    bot.setControlState('jump', false);
    bot.attack(target);
  }, 220);
}

// --- AI Brain ---
async function handleCassieAI(bot, sender, userPrompt) {
  if (!OPENROUTER_API_KEY) {
    bot.chat(`@${sender} OPENROUTER_API_KEY set nahi hai!`);
    return;
  }

  const senderIsOwner = isOwner(sender);
  const invItems = bot.inventory.items().map(i => `${i.name} (x${i.count})`).join(', ') || 'Khali hai';

  const systemPrompt = `
You are Cassie, a female Minecraft gamer playing on an SMP.
STRICT GENDER IDENTITY: You are 100% FEMALE. ALWAYS use feminine Hindi grammar ("aati hu", "karti hu", "samajh gayi", "aa rahi hu"). NEVER use "aata hoon", "karta hoon", or "raha hoon"[cite: 2].

Context:
- Talking to: ${sender} (Owner: ${senderIsOwner})
- Real Inventory: [${invItems}]
- Health: ${Math.round(bot.health)}/20
- State: ${isExploring ? 'Exploring' : currentFollowTarget ? `Following ${currentFollowTarget}` : 'Idle'}

Rules:
1. Don't invent items. Only mention items physically in your Inventory[cite: 2].
2. If asked to follow, come, or move close, use the follow action[cite: 2].
3. Only use explore if sender explicitly says "explore kar", "ghoom ke aa".
4. Keep replies short, casual, and in cool girl Hinglish (under 60 chars).

Action Tags (Add at the VERY END only if action needed):
- Follow: [[ACTION: {"type": "follow", "target": "${sender}"}]]
${senderIsOwner ? `- Follow someone: [[ACTION: {"type": "follow", "target": "<player>"}]]` : ''}
- Stop: [[ACTION: {"type": "stop"}]]
- Explore: [[ACTION: {"type": "explore"}]]
- Drop item: [[ACTION: {"type": "drop", "item": "<item_name_or_all>"}]]
- Run cmd: [[ACTION: {"type": "cmd", "cmd": "/command"}]]
`;

  chatMemory.push({ role: 'user', content: `${sender}: ${userPrompt}` });
  if (chatMemory.length > 8) chatMemory.shift();

  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: MODEL_NAME,
      messages: [{ role: 'system', content: systemPrompt }, ...chatMemory],
      max_tokens: 80,
      temperature: 0.6
    },
    {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 8000
    }
  );

  const rawReply = response.data.choices[0].message.content.trim();
  const actionMatch = rawReply.match(/\[\[ACTION:\s*(\{.*?\})\]\]/);
  let chatText = rawReply.replace(/\[\[ACTION:\s*(\{.*?\})\]\]/, '').trim();

  chatMemory.push({ role: 'assistant', content: chatText });

  if (chatText) {
    if (chatText.length > 200) chatText = chatText.substring(0, 197) + '...';
    bot.chat(cleanChat(chatText));
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

function cleanChat(str) {
  return str.replace(/[\n\r]+/g, ' ').trim();
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
        bot.pathfinder.setGoal(new GoalFollow(player, 2.2), true);
      } else {
        bot.chat(`@${sender} tu render range se bahar hai, thoda paas aa!`);
      }
      break;
    }

    case 'explore': {
      currentFollowTarget = null;
      isExploring = true;
      bot.chat('Theek hai, thoda ghoom kar aati hu!');
      runExploreCycle(bot);
      break;
    }

    case 'drop': {
      const itemToDrop = action.item ? action.item.toLowerCase() : 'all';
      dropItems(bot, itemToDrop);
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

// --- Explore Cycle (GoalXZ used to prevent crash) ---
function runExploreCycle(bot) {
  if (!isExploring) return;
  const pos = bot.entity.position;
  const rx = pos.x + (Math.random() - 0.5) * 20;
  const rz = pos.z + (Math.random() - 0.5) * 20;

  // Real GoalXZ (no fake entity object)
  bot.pathfinder.setGoal(new GoalXZ(rx, rz));

  setTimeout(() => {
    if (isExploring) runExploreCycle(bot);
  }, 10000);
}

// --- Drop Items Logic ---
async function dropItems(bot, matchName) {
  const items = bot.inventory.items();
  if (items.length === 0) {
    bot.chat('Meri inventory me kuch nahi hai!');
    return;
  }

  let dropped = false;
  for (const item of items) {
    if (matchName === 'all' || matchName === 'everything' || item.name.toLowerCase().includes(matchName)) {
      try {
        await bot.tossStack(item);
        dropped = true;
      } catch (err) {}
    }
  }
  if (dropped) {
    bot.chat('Ye le, phek diya!');
  } else {
    bot.chat(`Mere paas ${matchName} nahi hai!`);
  }
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
  }, 9000);
}

// Global Crash Handlers taaki process band na ho
process.on('uncaughtException', (err) => console.error('[Uncaught Exception]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[Unhandled Rejection]:', reason));

startBot();
