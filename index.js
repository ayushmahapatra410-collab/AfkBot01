const mineflayer = require('mineflayer');
const express = require('express');
const axios = require('axios');
const { Vec3 } = require('vec3');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow, GoalXZ } = goals;

// --- Web Server (24/7 Hosting) ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Cassie is Online with Gemma 4!'));
app.listen(port, () => console.log(`Listening on port ${port}`));

// --- Configurations ---
const SERVER_IP = 'YSsmpontop.aternos.me';
const BOT_USERNAME = 'Cassie';
const VERSION = '1.20.4';
const DEFAULT_SKIN = 'chloepowell';

// Owners
const OWNERS = ['NotGamerSpark', 'DusraOwnerUsername'].map(o => o.toLowerCase());

// OpenRouter Key & Gemma Model
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY || '';
const MODEL_NAME = 'google/gemma-4-26b-a4b-it';

let afkInterval = null;
let currentFollowTarget = null;
let isExploring = false;
let isWorking = false;
let isEating = false;
let isReconnecting = false;
let keyHoldTimeout = null;
let jumpCooldown = false;
let lastFoodAskTime = 0;

// Food items list
const FOOD_NAMES = [
  'cooked_beef', 'steak', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
  'golden_carrot', 'bread', 'baked_potato', 'apple', 'cooked_salmon', 'cooked_cod', 'carrot'
];

// Dangerous blocks to avoid
const HAZARDS = ['campfire', 'soul_campfire', 'fire', 'soul_fire', 'lava', 'magma_block', 'sweet_berry_bush'];

// Memory Buffer
let chatMemory = [];

function isOwner(username) {
  return username && OWNERS.includes(username.toLowerCase());
}

function startBot() {
  console.log(`[Connect] Connecting Cassie to ${SERVER_IP}...`);
  isReconnecting = false;

  const bot = mineflayer.createBot({
    host: SERVER_IP,
    username: BOT_USERNAME,
    version: VERSION
  });

  bot.loadPlugin(pathfinder);

  bot.on('spawn', () => {
    console.log(`✅ ${bot.username} spawned in world!`);
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

  // Greet on Join
  bot.on('playerJoined', (player) => {
    if (!player || player.username === bot.username) return;
    setTimeout(() => {
      if (isOwner(player.username)) {
        bot.chat(`Arey @${player.username} aagaye! Welcome back owner ji!`);
      } else {
        bot.chat(`Yo @${player.username}! Welcome to the server!`);
      }
    }, 2500);
  });

  // Auto Respawn
  bot.on('death', () => {
    stopAll(bot);
    setTimeout(() => {
      try { bot.respawn(); } catch (e) {}
    }, 2000);
  });

  // --- Real-Player Slab Jump + Hazard Avoidance (Campfire/Lava) ---
  bot.on('physicsTick', () => {
    // 1. HAZARD DETECTION (Campfire / Fire / Magma se turant bhago)
    const blockUnder = bot.blockAt(bot.entity.position);
    const blockDirectBelow = bot.blockAt(bot.entity.position.offset(0, -0.5, 0));

    const isStandingOnHazard = (blockUnder && HAZARDS.includes(blockUnder.name)) ||
                               (blockDirectBelow && HAZARDS.includes(blockDirectBelow.name));

    if (isStandingOnHazard) {
      bot.setControlState('jump', true);
      bot.setControlState('back', true);
      setTimeout(() => {
        bot.setControlState('jump', false);
        bot.setControlState('back', false);
      }, 400);
      return;
    }

    if (!currentFollowTarget || isEating || isWorking) return;

    const target = bot.players[currentFollowTarget]?.entity;
    if (!target) return;

    const dist = bot.entity.position.distanceTo(target.position);
    if (dist <= 2.2) {
      bot.clearControlStates();
      return;
    }

    bot.lookAt(target.position.offset(0, target.height * 0.85, 0), true);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', dist > 4.5);

    // Slab & obstacle jump
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

  // --- Auto Hunger / Health Food Routine ---
  bot.on('health', async () => {
    if (isEating) return;

    // Check if food needed
    if (bot.food < 16 || (bot.health < 17 && bot.food < 20)) {
      const foodItem = bot.inventory.items().find(i => FOOD_NAMES.includes(i.name));

      if (foodItem) {
        await consumeFood(bot, foodItem);
      } else {
        // Khana nahi hai to chat me maango (cooldown 20 seconds)
        const now = Date.now();
        if (now - lastFoodAskTime > 20000) {
          lastFoodAskTime = now;
          bot.chat('Mujhe bhookh lag rahi hai aur health kam ho rahi hai, thoda khana do na please!');
        }
      }
    }
  });

  // Self Defense with Critical Hits
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

    if (cleanMsg.startsWith('!cmd ')) {
      if (!isOwner(username)) {
        bot.chat(`@${username} Sirf owner console commands chala sakte hain!`);
        return;
      }
      bot.chat(cleanMsg.replace('!cmd ', '').trim());
      return;
    }

    if (cleanMsg === '!stop' || cleanMsg.toLowerCase() === '!cassie stop') {
      stopAll(bot, 'Ruk gayi, sab cancel!');
      return;
    }

    if (!cleanMsg.startsWith('!')) return;
    const query = cleanMsg.substring(1).trim().toLowerCase();
    if (!query) return;

    // Direct Key Combos
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
    if (['w', 'aage', 'forward'].includes(query)) {
      triggerComboKeys(bot, ['forward'], 1200);
      bot.chat('W pressed!');
      return;
    }
    if (['s', 'peeche', 'back'].includes(query)) {
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

    // Camera Look
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
    if (query.includes('meri taraf dekh') || query.includes('look at me')) {
      const player = bot.players[username]?.entity;
      if (player) {
        bot.lookAt(player.position.offset(0, player.height * 0.85, 0), true);
        bot.chat(`@${username} dekh rahi hu!`);
      }
      return;
    }

    // Vision
    if (query.includes('samne kya hai') || query.includes('kya dikh raha hai') || query === 'look') {
      reportVision(bot, username);
      return;
    }

    // Inventory
    if (query.includes('kya hai') || query === 'inv' || query === 'inventory' || query.includes('items')) {
      reportInventory(bot, username);
      return;
    }

    // Instant Follow
    if (query.includes('pass aa') || query.includes('follow') || query.includes('aaja') || query.includes('mere pass')) {
      isExploring = false;
      bot.pathfinder.stop();
      const player = bot.players[username]?.entity;
      if (player) {
        currentFollowTarget = username;
        bot.chat(`Aa rahi hu @${username}!`);
      } else {
        bot.chat(`@${username} Render range me nahi dikh raha tu, thoda samne aa!`);
      }
      return;
    }

    // Work Shortcuts
    if (query.includes('tree') || query.includes('ped kaat') || query.includes('wood')) {
      chopNearestTrees(bot);
      return;
    }
    if (query.includes('torch tod') || query.includes('break torch') || query.includes('torches break')) {
      breakAllTorchesAround(bot);
      return;
    }
    if (query.includes('torch laga') || query.includes('light up') || query.includes('torch')) {
      placeTorchOnGround(bot);
      return;
    }
    if (query.includes('block tod') || query.includes('break block') || query.includes('dig')) {
      breakBlockInFront(bot);
      return;
    }
    if (query.includes('khana khao') || query.includes('eat')) {
      forceEatFood(bot);
      return;
    }

    // OpenRouter Gemma 4 AI Brain
    try {
      await handleCassieAI(bot, username, cleanMsg.substring(1).trim());
    } catch (err) {
      const errorMsg = err.response?.data?.error?.message || err.message;
      console.error('AI Error:', errorMsg);
      bot.chat(`@${username} Dimag lag ho gaya: ${errorMsg.substring(0, 45)}`);
    }
  });

  // Combat loop
  setInterval(() => {
    if (currentFollowTarget || isExploring || isWorking || isEating) return;
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

  bot.on('kicked', (reason) => console.log(`[Kicked]: ${reason}`));

  bot.on('end', () => {
    if (isReconnecting) return;
    isReconnecting = true;
    console.log('🔴 Disconnected. Waiting 25s safe cooldown...');
    if (afkInterval) clearInterval(afkInterval);
    stopAll(bot);
    setTimeout(startBot, 25000);
  });

  bot.on('error', (e) => console.error('[Bot Error]:', e.message));
}

// Multi-Key Simulator
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

// --- Food Consume Engine ---
async function consumeFood(bot, foodItem) {
  if (isEating) return;
  isEating = true;

  const currentWeapon = bot.inventory.items().find(i => i.name.includes('sword') || i.name.includes('axe'));

  try {
    bot.chat('Ruko, thoda khana kha leti hu!');
    await bot.equip(foodItem, 'hand');
    await bot.consume();
    bot.chat('Mast khana tha! Pet bhar gaya.');

    // Khane ke baad wapas weapon hotbar me equip kare
    if (currentWeapon) {
      await bot.equip(currentWeapon, 'hand');
    }
  } catch (e) {
    console.error('Eat error:', e.message);
  } finally {
    isEating = false;
  }
}

async function forceEatFood(bot) {
  const foodItem = bot.inventory.items().find(i => FOOD_NAMES.includes(i.name));
  if (foodItem) {
    await consumeFood(bot, foodItem);
  } else {
    bot.chat('Mere paas koi khane ka item nahi hai!');
  }
}

// --- Break ALL Torches Nearby (Dhoondh ke todna) ---
async function breakAllTorchesAround(bot) {
  if (isWorking) return;
  isWorking = true;

  const torchPositions = bot.findBlocks({
    matching: (b) => b && b.name && (b.name.includes('torch')),
    maxDistance: 12,
    count: 20
  });

  if (!torchPositions || torchPositions.length === 0) {
    bot.chat('Aas-paas koi torch nahi mili todne ke liye!');
    isWorking = false;
    return;
  }

  bot.chat(`${torchPositions.length} torches mili hain, sab tod rahi hu!`);

  for (const pos of torchPositions) {
    const block = bot.blockAt(pos);
    if (!block || !block.name.includes('torch')) continue;

    try {
      await bot.lookAt(pos, true);
      await bot.dig(block);
      await bot.waitForTicks(4);
    } catch (err) {
      continue;
    }
  }

  bot.chat('Saari torches tod di!');
  isWorking = false;
}

// Vision
function reportVision(bot, sender) {
  const block = bot.blockAtCursor(5);
  const targetEntity = bot.nearestEntity(e => e.type !== 'object' && e !== bot.entity && bot.entity.position.distanceTo(e.position) < 6);

  let desc = [];
  if (block && block.name !== 'air') desc.push(`samne ${block.displayName || block.name} hai`);
  if (targetEntity) desc.push(`paas me ek ${targetEntity.displayName || targetEntity.name} hai`);

  if (desc.length > 0) {
    bot.chat(`@${sender} Mujhe ${desc.join(' aur ')}!`);
  } else {
    bot.chat(`@${sender} Samne plain area hai, kuch khas nahi dikh raha!`);
  }
}

// Torch Placement
async function placeTorchOnGround(bot) {
  const torch = bot.inventory.items().find(i => i.name.includes('torch'));
  if (!torch) {
    bot.chat('Mere paas koi torch nahi hai!');
    return;
  }
  const blockBelow = bot.blockAt(bot.entity.position.offset(0, -1, 0));
  if (!blockBelow || blockBelow.name === 'air') {
    bot.chat('Zameen theek nahi hai!');
    return;
  }
  try {
    await bot.equip(torch, 'hand');
    await bot.placeBlock(blockBelow, new Vec3(0, 1, 0));
    bot.chat('Torch laga di!');
  } catch (err) {
    bot.chat('Torch lagane me dikkat aayi!');
  }
}

// Break block in front
async function breakBlockInFront(bot) {
  const targetBlock = bot.blockAtCursor(4);
  if (!targetBlock || targetBlock.name === 'air' || targetBlock.name === 'bedrock') {
    bot.chat('Samne koi todne layak block nahi hai!');
    return;
  }
  const tool = bot.pathfinder.bestHarvestTool(targetBlock);
  if (tool) {
    try { await bot.equip(tool, 'hand'); } catch (e) {}
  }
  try {
    bot.chat(`Tod rahi hu ${targetBlock.displayName || targetBlock.name}...`);
    await bot.dig(targetBlock);
    bot.chat('Block tod diya!');
  } catch (err) {
    bot.chat('Block todne me issue hua!');
  }
}

// Chop Trees & Replant
async function chopNearestTrees(bot) {
  if (isWorking) return;
  isWorking = true;

  const logs = bot.findBlocks({
    matching: (b) => b && b.name && b.name.includes('_log'),
    maxDistance: 15,
    count: 10
  });

  if (!logs || logs.length === 0) {
    bot.chat('Aas-paas koi trees nahi dikh rahe!');
    isWorking = false;
    return;
  }

  bot.chat('Wood cut karna shuru kar rahi hu!');

  for (const pos of logs) {
    const block = bot.blockAt(pos);
    if (!block || !block.name.includes('_log')) continue;

    const axe = bot.inventory.items().find(i => i.name.includes('axe'));
    if (axe) {
      try { await bot.equip(axe, 'hand'); } catch (e) {}
    }

    try {
      await bot.lookAt(pos, true);
      await bot.dig(block);
      await bot.waitForTicks(5);
    } catch (e) {
      break;
    }
  }

  const sapling = bot.inventory.items().find(i => i.name.includes('sapling'));
  if (sapling && logs.length > 0) {
    const groundPos = logs[0].offset(0, -1, 0);
    const ground = bot.blockAt(groundPos);
    if (ground && (ground.name.includes('dirt') || ground.name.includes('grass'))) {
      try {
        await bot.equip(sapling, 'hand');
        await bot.placeBlock(ground, new Vec3(0, 1, 0));
        bot.chat('Naya sapling bhi laga diya!');
      } catch (e) {}
    }
  }

  isWorking = false;
  bot.chat('Ped kat gaye!');
}

// Inventory
function reportInventory(bot, sender) {
  const items = bot.inventory.items();
  if (items.length === 0) {
    bot.chat(`@${sender} Mera bag ekdam khali hai!`);
    return;
  }
  const summary = items.map(i => `${i.displayName || i.name} x${i.count}`).join(', ');
  bot.chat(`@${sender} Mere paas: ${summary.length > 170 ? summary.substring(0, 165) + '...' : summary}`);
}

// Drop items
async function dropItems(bot, matchName) {
  const items = bot.inventory.items();
  if (items.length === 0) {
    bot.chat('Meri inventory me kuch nahi hai!');
    return;
  }

  const toDrop = items.filter(item => 
    matchName === 'all' || matchName === 'everything' || matchName === 'sab' || item.name.toLowerCase().includes(matchName)
  );

  if (toDrop.length === 0) {
    bot.chat(`Mere paas ${matchName} nahi hai!`);
    return;
  }

  bot.chat(matchName === 'all' || matchName === 'sab' ? 'Saare stacks ek-ek karke phek rahi hu!' : `${matchName} phek rahi hu!`);

  for (const item of toDrop) {
    try {
      await bot.tossStack(item);
      await bot.waitForTicks(6);
    } catch (err) {}
  }
  bot.chat('Ye lo, sab drop kar diya!');
}

// Combat Critical Attack
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

// Gemma AI Brain via OpenRouter
async function handleCassieAI(bot, sender, userPrompt) {
  if (!OPENROUTER_API_KEY) {
    bot.chat(`@${sender} OPENROUTER_API_KEY set nahi hai!`);
    return;
  }

  const senderIsOwner = isOwner(sender);
  const invItems = bot.inventory.items().map(i => `${i.name} (x${i.count})`).join(', ') || 'Khali hai';

  const systemPrompt = `
You are Cassie, a friendly and pro female gamer playing as a companion on a Minecraft SMP.
STRICT GENDER IDENTITY: You are 100% FEMALE. ALWAYS use feminine Hindi grammar ("aati hu", "karti hu", "samajh gayi", "aa rahi hu"). NEVER use "aata hoon", "karta hoon", or "raha hoon".

Context:
- Talking to: ${sender} (Owner: ${senderIsOwner})
- Real Inventory: [${invItems}]
- Health: ${Math.round(bot.health)}/20
- Food: ${Math.round(bot.food)}/20

Rules:
1. When asked about inventory, look at Real Inventory and state accurately.
2. If asked to follow, move, chop trees, break torches, place torch, eat food, or drop items, output appropriate ACTION.
3. Keep replies short, casual, and in cool girl Hinglish (under 60 chars).

Action Tags (Add at the VERY END only if action needed):
- Follow: [[ACTION: {"type": "follow", "target": "${sender}"}]]
- Stop: [[ACTION: {"type": "stop"}]]
- Drop: [[ACTION: {"type": "drop", "item": "<item_name_or_all>"}]]
- Chop: [[ACTION: {"type": "chop"}]]
- Torch: [[ACTION: {"type": "torch"}]]
- BreakTorch: [[ACTION: {"type": "break_torches"}]]
- Break: [[ACTION: {"type": "break"}]]
- Eat: [[ACTION: {"type": "eat"}]]
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

async function executeAction(bot, sender, senderIsOwner, action) {
  switch (action.type) {
    case 'follow': {
      isExploring = false;
      const player = bot.players[action.target || sender]?.entity;
      if (player) {
        currentFollowTarget = action.target || sender;
      }
      break;
    }
    case 'chop': {
      chopNearestTrees(bot);
      break;
    }
    case 'torch': {
      placeTorchOnGround(bot);
      break;
    }
    case 'break_torches': {
      breakAllTorchesAround(bot);
      break;
    }
    case 'break': {
      breakBlockInFront(bot);
      break;
    }
    case 'eat': {
      forceEatFood(bot);
      break;
    }
    case 'drop': {
      dropItems(bot, (action.item || 'all').toLowerCase());
      break;
    }
    case 'stop': {
      stopAll(bot, 'Ruk gayi!');
      break;
    }
  }
}

function stopAll(bot, msg) {
  currentFollowTarget = null;
  isExploring = false;
  isWorking = false;
  isEating = false;
  if (keyHoldTimeout) clearTimeout(keyHoldTimeout);
  bot.pathfinder.stop();
  bot.clearControlStates();
  if (msg) bot.chat(msg);
}

function startSafeAfk(bot) {
  if (afkInterval) clearInterval(afkInterval);
  afkInterval = setInterval(() => {
    if (bot.pathfinder.isMoving() || currentFollowTarget || isExploring || isWorking || isEating) return;
    bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.4, false);
    if (Math.random() > 0.5) bot.swingArm('right');
  }, 9000);
}

// Error guards
process.on('uncaughtException', (err) => console.error('[Uncaught Exception]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[Unhandled Rejection]:', reason));

startBot();
