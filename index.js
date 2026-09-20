const mineflayer = require('mineflayer');
const express = require('express');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalXZ } = goals;

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Cassie Pro is Running!'));
app.listen(port, () => console.log(`Listening on port ${port}`));

// --- Configurations ---
const SERVER_IP = 'YSsmpontop.aternos.me';
const BOT_USERNAME = 'Cassie';
const VERSION = '1.20.4';
const DEFAULT_SKIN = 'chloepowell';

// Dono Owners
const OWNERS = ['NotGamerSpark', 'DusraOwnerUsername'].map(o => o.toLowerCase());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL_NAME = 'z-ai/glm-5.2:free'; // Tera exact GLM 5.2 free model

let afkInterval = null;
let currentFollowTarget = null;
let isExploring = false;
let isReconnecting = false;
let keyHoldTimeout = null;
let jumpCooldown = false;

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

      defaultMove.canDig = false;           
      defaultMove.allowParkour = true;      
      defaultMove.allowSprinting = true;    
      defaultMove.canOpenDoors = true;      
      defaultMove.maxDropDown = 4;          
      defaultMove.liquidCost = 25;
      defaultMove.entityCost = 0;

      bot.pathfinder.setMovements(defaultMove);
    } catch (e) {
      console.error('Movement init error:', e.message);
    }

    setTimeout(() => bot.chat(`/skin ${DEFAULT_SKIN}`), 3000);
    startSafeAfk(bot);
  });

  // --- AUTO GREET ON PLAYER JOIN ---
  bot.on('playerJoined', (player) => {
    if (!player || player.username === bot.username) return;

    // 2.5 second delay taaki player properly render/load ho jaye
    setTimeout(() => {
      if (isOwner(player.username)) {
        const ownerGreetings = [
          `Arey @${player.username} aagaye! Welcome back owner ji!`,
          `Welcome @${player.username}! Server ki raunak wapas aagayi!`,
          `Hey @${player.username}! Kahan the itni der se? Mast timing pe aaye!`
        ];
        const greet = ownerGreetings[Math.floor(Math.random() * ownerGreetings.length)];
        bot.chat(greet);
      } else {
        const memberGreetings = [
          `Yo @${player.username}! Welcome to the server!`,
          `Hey @${player.username}, welcome! Sab theek thak?`,
          `Aaja @${player.username}, grind shuru karein!`
        ];
        const greet = memberGreetings[Math.floor(Math.random() * memberGreetings.length)];
        bot.chat(greet);
      }
    }, 2500);
  });

  bot.on('death', () => {
    logGameEvent('Mar gayi!');
    stopAll(bot);
    setTimeout(() => {
      try { bot.respawn(); } catch (e) {}
    }, 2000);
  });

  // --- 100% REAL HUMAN WASD + SLAB JUMP ENGINE ---
  bot.on('physicsTick', () => {
    if (!currentFollowTarget) return;

    const target = bot.players[currentFollowTarget]?.entity;
    if (!target) return;

    const dist = bot.entity.position.distanceTo(target.position);

    // Agar 2 blocks ke andar hai toh shanti se khadi rahe
    if (dist <= 2.2) {
      bot.clearControlStates();
      return;
    }

    // Direct line of sight: target ke face ki taraf dekhe
    bot.lookAt(target.position.offset(0, target.height * 0.85, 0), true);

    // Continuous smooth forward walk
    bot.setControlState('forward', true);
    bot.setControlState('sprint', dist > 4.5);

    // Real spacebar jump tap for slabs and blocks
    const isCollided = bot.entity.isCollidedHorizontally;
    const blockAhead = bot.blockAtCursor(1.6);
    const hasObstacle = blockAhead && (blockAhead.name.includes('slab') || blockAhead.name.includes('stair') || blockAhead.boundingBox === 'block');

    if ((isCollided || hasObstacle) && !jumpCooldown) {
      jumpCooldown = true;
      bot.setControlState('jump', true);

      setTimeout(() => {
        bot.setControlState('jump', false);
        jumpCooldown = false;
      }, 300);
    }
  });

  // Self Defense
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

    // Stop Everything
    if (cleanMsg === '!stop' || cleanMsg.toLowerCase() === '!cassie stop') {
      stopAll(bot, 'Ruk gayi, sab cancel!');
      return;
    }

    if (!cleanMsg.startsWith('!')) return;
    const query = cleanMsg.substring(1).trim().toLowerCase();
    if (!query) return;

    // --- MULTI-KEY COMBOS (W + Space, Sprint Jump, etc.) ---
    if (query === 'w+space' || query === 'w space' || query.includes('jump walk') || query === 'kud ke aage aa') {
      triggerComboKeys(bot, ['forward', 'jump'], 1400);
      bot.chat('W + Space daba rahi hu!');
      return;
    }
    if (query === 'sprint jump' || query === 'w+space+sprint' || query === 'bhaag ke kudo') {
      triggerComboKeys(bot, ['forward', 'jump', 'sprint'], 1400);
      bot.chat('Sprint jump maar rahi hu!');
      return;
    }
    if (query === 'w+d' || query === 'w d') {
      triggerComboKeys(bot, ['forward', 'right'], 1000);
      bot.chat('W + D pressed!');
      return;
    }
    if (query === 'w+a' || query === 'w a') {
      triggerComboKeys(bot, ['forward', 'left'], 1000);
      bot.chat('W + A pressed!');
      return;
    }

    // --- SINGLE KEYS (WASD / JUMP / SNEAK) ---
    if (['w', 'aage', 'forward'].includes(query)) {
      triggerComboKeys(bot, ['forward'], 1200);
      bot.chat('W pressed!');
      return;
    }
    if (['s', 'peeche', 'back', 'backward'].includes(query)) {
      triggerComboKeys(bot, ['back'], 1200);
      bot.chat('S pressed!');
      return;
    }
    if (['a', 'left'].includes(query)) {
      triggerComboKeys(bot, ['left'], 1200);
      bot.chat('A pressed!');
      return;
    }
    if (['d', 'right'].includes(query)) {
      triggerComboKeys(bot, ['right'], 1200);
      bot.chat('D pressed!');
      return;
    }
    if (['space', 'jump', 'kudo'].includes(query)) {
      triggerComboKeys(bot, ['jump'], 500);
      bot.chat('Jumped!');
      return;
    }
    if (['crouch', 'sneak', 'shift'].includes(query)) {
      const isSneaking = bot.getControlState('sneak');
      bot.setControlState('sneak', !isSneaking);
      bot.chat(!isSneaking ? 'Sneak on!' : 'Sneak off!');
      return;
    }

    // --- MOUSE CAMERA LOOK ---
    if (query.includes('upar dekh') || query === 'look up') {
      bot.look(bot.entity.yaw, Math.PI / 3, true);
      bot.chat('Upar dekh rahi hu!');
      return;
    }
    if (query.includes('niche dekh') || query === 'look down') {
      bot.look(bot.entity.yaw, -Math.PI / 3, true);
      bot.chat('Niche dekh rahi hu!');
      return;
    }
    if (query.includes('left dekh') || query === 'look left') {
      bot.look(bot.entity.yaw + Math.PI / 2, bot.entity.pitch, true);
      bot.chat('Left ghumaya!');
      return;
    }
    if (query.includes('right dekh') || query === 'look right') {
      bot.look(bot.entity.yaw - Math.PI / 2, bot.entity.pitch, true);
      bot.chat('Right ghumaya!');
      return;
    }
    if (query.includes('meri taraf dekh') || query.includes('look at me')) {
      const player = bot.players[username]?.entity;
      if (player) {
        bot.lookAt(player.position.offset(0, player.height * 0.85, 0), true);
        bot.chat(`@${username} dekh rahi hu!`);
      } else {
        bot.chat(`@${username} tu dikh nahi raha!`);
      }
      return;
    }

    // --- INVENTORY SCANNER ---
    if (query.includes('kya hai') || query === 'inv' || query === 'inventory' || query.includes('items')) {
      reportInventory(bot, username);
      return;
    }

    // --- ZERO-LAG INSTANT FOLLOW SHORTCUT ---
    if (query.includes('pass aa') || query.includes('follow') || query.includes('aaja') || query.includes('mere pass')) {
      isExploring = false;
      bot.pathfinder.stop(); // Buggy pathfinder band
      const player = bot.players[username]?.entity;
      if (player) {
        currentFollowTarget = username;
        bot.chat(`Aa rahi hu @${username}!`);
      } else {
        bot.chat(`@${username} Tu render range me nahi hai, thoda samne aa!`);
      }
      return;
    }

    // AI Chat via GLM 5.2 Free
    try {
      await handleCassieAI(bot, username, cleanMsg.substring(1).trim());
    } catch (err) {
      console.error('AI Error:', err.response?.data || err.message);
      bot.chat(`@${username} Mera dimag lag ho gaya, dobara bolna!`);
    }
  });

  // Auto Mob Combat Loop
  setInterval(() => {
    if (currentFollowTarget || isExploring) return;
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

// --- Multi-Key Simulator ---
function triggerComboKeys(bot, controls = [], durationMs = 1200) {
  bot.pathfinder.stop();
  currentFollowTarget = null;
  isExploring = false;

  if (keyHoldTimeout) clearTimeout(keyHoldTimeout);
  controls.forEach(ctrl => bot.setControlState(ctrl, true));

  keyHoldTimeout = setTimeout(() => {
    controls.forEach(ctrl => bot.setControlState(ctrl, false));
    bot.clearControlStates();
  }, durationMs);
}

// --- Inventory Reporter ---
function reportInventory(bot, sender) {
  const items = bot.inventory.items();
  if (items.length === 0) {
    bot.chat(`@${sender} Mera bag ekdam khali hai!`);
    return;
  }
  const summary = items.map(i => `${i.displayName || i.name} x${i.count}`).join(', ');
  bot.chat(`@${sender} Mere paas: ${summary.length > 170 ? summary.substring(0, 165) + '...' : summary}`);
}

// --- Combat ---
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

// --- AI Brain (GLM 5.2 Free) ---
async function handleCassieAI(bot, sender, userPrompt) {
  if (!OPENROUTER_API_KEY) {
    bot.chat(`@${sender} OPENROUTER_API_KEY set nahi hai!`);
    return;
  }

  const senderIsOwner = isOwner(sender);
  const invItems = bot.inventory.items().map(i => `${i.name} (x${i.count})`).join(', ') || 'Khali hai';

  const systemPrompt = `
You are Cassie, a female Minecraft gamer playing on an SMP.
STRICT GENDER IDENTITY: You are 100% FEMALE. ALWAYS use feminine Hindi grammar ("aati hu", "karti hu", "samajh gayi", "aa rahi hu"). NEVER use "aata hoon", "karta hoon", or "raha hoon".

Context:
- Talking to: ${sender} (Owner: ${senderIsOwner})
- Real Inventory: [${invItems}]
- Health: ${Math.round(bot.health)}/20
- State: ${isExploring ? 'Exploring' : currentFollowTarget ? `Following ${currentFollowTarget}` : 'Idle'}

Rules:
1. When asked about inventory, look at Real Inventory and state accurately.
2. If asked to follow, move, or explore, trigger actions appropriately.
3. Keep replies short, casual, and in cool girl Hinglish (under 60 chars).

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
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://railway.app',
        'X-Title': 'Cassie Minecraft Bot'
      },
      timeout: 9000
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
      stopAll(bot, 'Ruk gayi!');
      break;
    }

    case 'cmd': {
      if (senderIsOwner && action.cmd) bot.chat(action.cmd);
      break;
    }
  }
}

// --- Explore Cycle ---
function runExploreCycle(bot) {
  if (!isExploring) return;
  const pos = bot.entity.position;
  const rx = pos.x + (Math.random() - 0.5) * 20;
  const rz = pos.z + (Math.random() - 0.5) * 20;

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
  if (keyHoldTimeout) clearTimeout(keyHoldTimeout);
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

// Global Crash Shield
process.on('uncaughtException', (err) => console.error('[Uncaught Exception]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[Unhandled Rejection]:', reason));

startBot();
