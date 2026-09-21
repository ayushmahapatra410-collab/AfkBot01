const mineflayer = require('mineflayer');
const express = require('express');
const { Vec3 } = require('vec3');
const { GoogleGenAI } = require('@google/genai');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow, GoalNear, GoalXZ, GoalBlock } = goals;

// --- Web Server (Keep-Alive Shield) ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Cassie is Online with Gemini 3.6 Flash!'));
app.listen(port, () => console.log(`[Web] Listening on port ${port}`));

// --- Server Configurations ---
const SERVER_IP = 'YSsmpontop.aternos.me';
const BOT_USERNAME = 'Cassie';
const VERSION = '1.20.4';
const DEFAULT_SKIN = 'chloepowell';

// 12 Chunks Simulation Boundary (12 * 16 = 192 blocks)
const MAX_SIMULATION_RADIUS = 192;
let spawnAnchor = null;

// Owners List
const OWNERS = ['NotGamerSpark', 'yuzu'].map(o => o.toLowerCase());

// Google AI Studio API Key & Model Configuration
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const MODEL_NAME = 'gemini-3.6-flash';

// Initialize Google GenAI SDK
let ai = null;
if (GEMINI_API_KEY) {
  ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}

// State Machine
let afkInterval = null;
let currentFollowTarget = null;
let isExploring = false;
let isWorking = false;
let isEating = false;
let isSleeping = false;
let isReconnecting = false;
let keyHoldTimeout = null;
let jumpCooldown = false;
let lastHealthAlert = 0;
let lastFoodAlert = 0;
let lastSleepAttempt = 0;

// Food Database
const FOOD_NAMES = [
  'cooked_beef', 'steak', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
  'golden_carrot', 'bread', 'baked_potato', 'apple', 'cooked_salmon', 'cooked_cod', 'carrot'
];

// Hazard Blocks (Campfire, Lava, Fire, Magma)
const HAZARDS = ['campfire', 'soul_campfire', 'fire', 'soul_fire', 'lava', 'magma_block', 'sweet_berry_bush'];

// Chat Memory Buffer
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

  // 1. Spawn Event & Movements Setup
  bot.on('spawn', () => {
    console.log(`✅ ${bot.username} spawned into the world!`);
    spawnAnchor = bot.entity.position.clone();

    try {
      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);

      defaultMove.canDig = true;
      defaultMove.allowParkour = true;
      defaultMove.allowSprinting = true;
      defaultMove.canOpenDoors = true;
      defaultMove.maxDropDown = 4;
      defaultMove.liquidCost = 25;
      defaultMove.entityCost = 0;

      bot.pathfinder.setMovements(defaultMove);
    } catch (e) {
      console.error('Movement setup error:', e.message);
    }

    setTimeout(() => bot.chat(`/skin ${DEFAULT_SKIN}`), 3000);
    startSafeAfk(bot);
  });

  // 2. Auto Respawn on Death
  bot.on('death', () => {
    stopAll(bot);
    setTimeout(() => {
      try { bot.respawn(); } catch (e) {}
    }, 2000);
  });

  // 3. Human Physics, Hazard Avoidance & 12-Chunk Edge Protection
  bot.on('physicsTick', () => {
    // 12-Chunk Boundary Guard
    if (spawnAnchor) {
      const distFromCenter = bot.entity.position.distanceTo(spawnAnchor);
      if (distFromCenter > MAX_SIMULATION_RADIUS) {
        bot.clearControlStates();
        bot.pathfinder.stop();
        isExploring = false;
        bot.chat('Simulation boundary ke edge par aa gayi, peeche mud rahi hu!');
        bot.lookAt(spawnAnchor, true);
        bot.setControlState('forward', true);
        setTimeout(() => bot.clearControlStates(), 2200);
        return;
      }
    }

    // Hazard Guard (Campfire, Lava, Fire)
    const blockUnder = bot.blockAt(bot.entity.position);
    const blockDirectBelow = bot.blockAt(bot.entity.position.offset(0, -0.5, 0));
    const isHazard = (blockUnder && HAZARDS.includes(blockUnder.name)) ||
                     (blockDirectBelow && HAZARDS.includes(blockDirectBelow.name));

    if (isHazard) {
      bot.setControlState('jump', true);
      bot.setControlState('back', true);
      setTimeout(() => {
        bot.setControlState('jump', false);
        bot.setControlState('back', false);
      }, 400);
      return;
    }

    if (!currentFollowTarget || isEating || isWorking || isSleeping) return;

    const target = bot.players[currentFollowTarget]?.entity;
    if (!target) return;

    const dist = bot.entity.position.distanceTo(target.position);
    if (dist <= 2.2) {
      bot.clearControlStates();
      return;
    }

    // Camera track
    bot.lookAt(target.position.offset(0, target.height * 0.85, 0), true);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', dist > 4.5);

    // Obstacle / Slab / Stair Jump + Anti-Stuck Strafe
    const isCollided = bot.entity.isCollidedHorizontally;
    const blockAhead = bot.blockAtCursor(1.6);
    const hasObstacle = blockAhead && (blockAhead.name.includes('slab') || blockAhead.name.includes('stair') || blockAhead.boundingBox === 'block');

    if ((isCollided || hasObstacle) && !jumpCooldown) {
      jumpCooldown = true;
      bot.setControlState('jump', true);
      if (isCollided) bot.setControlState('left', Math.random() > 0.5);

      setTimeout(() => {
        bot.setControlState('jump', false);
        bot.setControlState('left', false);
        jumpCooldown = false;
      }, 320);
    }
  });

  // 4. Survival: 50% Health Warning & Food Consumption
  bot.on('health', async () => {
    if (isEating || isSleeping) return;
    const now = Date.now();

    // 50% Health Alert
    if (bot.health <= 10 && bot.health > 0) {
      if (now - lastHealthAlert > 20000) {
        lastHealthAlert = now;
        bot.chat(`Warning! Meri health 50% ho chuki hai (${Math.round(bot.health)}/20)! Sambhalo mujhe!`);
      }
    }

    // Hunger Check
    if (bot.food < 15 || (bot.health < 18 && bot.food < 20)) {
      const foodItem = bot.inventory.items().find(i => FOOD_NAMES.includes(i.name));
      if (foodItem) {
        await consumeFood(bot, foodItem);
      } else if (now - lastFoodAlert > 25000) {
        lastFoodAlert = now;
        bot.chat('Mujhe bhookh lag rahi hai, thoda khana do please!');
      }
    }
  });

  // 5. Night Bed Sleep Routine (Anti-Spam 60s Cooldown)
  bot.on('time', async () => {
    if (isSleeping || isWorking) return;

    const now = Date.now();
    if (now - lastSleepAttempt < 60000) return;

    const time = bot.time.timeOfDay;
    if (time >= 12500 && time <= 23000) {
      const bed = bot.findBlock({
        matching: (b) => b && b.name.includes('bed'),
        maxDistance: 16
      });

      if (bed) {
        lastSleepAttempt = now;
        try {
          isSleeping = true;
          stopAll(bot);
          bot.chat('Raat ho gayi hai, sone jaa rahi hu!');
          await bot.sleep(bed);
          bot.chat('Good night guys!');
        } catch (err) {
          isSleeping = false;
        }
      }
    }
  });

  bot.on('wake', () => {
    isSleeping = false;
    bot.chat('Subah ho gayi, uth gayi hu!');
  });

  // 6. Self Defense with Critical Hits
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    const attacker = bot.nearestEntity(e => 
      (e.type === 'mob' || (e.type === 'player' && !isOwner(e.username))) &&
      bot.entity.position.distanceTo(e.position) < 5
    );
    if (attacker) proAttack(bot, attacker);
  });

  // 7. Main Chat Router & Parser
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    const cleanMsg = message.trim();

    // Owner Console Command
    if (cleanMsg.startsWith('!cmd ')) {
      if (!isOwner(username)) {
        bot.chat(`@${username} Sirf owner console commands chala sakte hain!`);
        return;
      }
      bot.chat(cleanMsg.replace('!cmd ', '').trim());
      return;
    }

    // Stop Everything Override
    if (cleanMsg === '!stop' || cleanMsg.toLowerCase() === '!cassie stop' || cleanMsg.toLowerCase() === '!ruk' || cleanMsg.toLowerCase() === '!rukja') {
      stopAll(bot, 'Ruk gayi, sab cancel!');
      return;
    }

    if (!cleanMsg.startsWith('!')) return;
    const query = cleanMsg.substring(1).trim().toLowerCase();
    if (!query) return;

    const isNegative = query.includes('mat') || query.includes('not') || query.includes('dont') || query.includes('nahi');

    // --- MULTI-KEY COMBOS ---
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
    if (query === 's+d' || query === 's d') {
      triggerComboKeys(bot, ['back', 'right'], 1000);
      bot.chat('S + D pressed!');
      return;
    }
    if (query === 's+a' || query === 's a') {
      triggerComboKeys(bot, ['back', 'left'], 1000);
      bot.chat('S + A pressed!');
      return;
    }

    // --- SINGLE WASD KEYS ---
    if (['w', 'aage', 'forward'].includes(query)) {
      triggerComboKeys(bot, ['forward'], 1200);
      bot.chat('W pressed!');
      return;
    }
    if (['s', 'peeche', 'back', 'pichhe'].includes(query)) {
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

    // --- MOUSE CAMERA CONTROLS ---
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

    // --- SMART EXPLORE ---
    if (!isNegative && (query === 'explore' || query.includes('explore kar') || query.includes('ghoom ke aa') || query.includes('explore on ur own'))) {
      currentFollowTarget = null;
      isExploring = true;
      bot.pathfinder.stop();
      bot.clearControlStates();
      bot.chat('Theek hai, akele explore karne jaa rahi hu!');
      runExploreCycle(bot);
      return;
    }

    // --- SMART FOLLOW ---
    if (!isNegative && (query.includes('pass aa') || query.includes('follow') || query.includes('aaja') || query.includes('mere pass') || query.includes('idhr aa') || query.includes('idhar aa'))) {
      isExploring = false;
      const player = bot.players[username]?.entity;
      if (player) {
        currentFollowTarget = username;
        bot.pathfinder.setGoal(new GoalFollow(player, 2.0), true);
        bot.chat(`Aa rahi hu @${username}!`);
      } else {
        const targetPlayer = bot.players[username];
        if (targetPlayer && targetPlayer.entity) {
          bot.pathfinder.setGoal(new GoalNear(targetPlayer.entity.position.x, targetPlayer.entity.position.y, targetPlayer.entity.position.z, 2));
          bot.chat(`Door ho gaye ho, location par aa rahi hu!`);
        } else {
          bot.chat(`@${username} Render range me nahi dikh rahe ho!`);
        }
      }
      return;
    }

    // --- EXACT COUNT BLOCK MINING (e.g. "!5 wood tod", "!3 stone break") ---
    const mineRegex = /(?:(\d+)\s+)?([a-zA-Z_]+)\s+(?:tod|break|mine|kaat)/i;
    const match = query.match(mineRegex);
    if (match && !query.includes('torch')) {
      const count = match[1] ? parseInt(match[1]) : 1;
      const blockName = match[2].toLowerCase();
      mineSpecificBlocks(bot, blockName, count);
      return;
    }

    // --- DIRECT ITEM SWITCH ENGINE ---
    if (query.includes('switch') || query.includes('pakad') || query.includes('equip') || query.includes('hath me le')) {
      let targetItem = null;
      if (query.includes('sword') || query.includes('talwar')) targetItem = 'sword';
      else if (query.includes('stick')) targetItem = 'stick';
      else if (query.includes('axe') || query.includes('kulhadi')) targetItem = 'axe';
      else if (query.includes('pickaxe')) targetItem = 'pickaxe';
      else if (query.includes('torch')) targetItem = 'torch';

      if (targetItem) {
        const itemObj = bot.inventory.items().find(i => i.name.toLowerCase().includes(targetItem));
        if (itemObj) {
          try {
            await bot.equip(itemObj, 'hand');
            bot.chat(`${itemObj.displayName || itemObj.name} pakad liya!`);
          } catch (e) {
            bot.chat('Item pakadne me dikkat aayi!');
          }
        } else {
          bot.chat(`Mere paas koi ${targetItem} nahi hai!`);
        }
        return;
      }
    }

    // --- TORCH MECHANICS ---
    if (query.includes('torch tod') || query.includes('break torch') || query.includes('torches break') || query.includes('torch hatao')) {
      breakAllTorchesAround(bot);
      return;
    }
    if (query.includes('torch laga') || query.includes('torch place')) {
      placeTorchOnGround(bot);
      return;
    }

    // --- VISION & INVENTORY ---
    if (query.includes('samne kya hai') || query.includes('kya dikh raha hai') || query === 'look') {
      reportVision(bot, username);
      return;
    }
    if (query.includes('kya hai') || query === 'inv' || query === 'inventory' || query.includes('items')) {
      reportInventory(bot, username);
      return;
    }

    // --- TREE CHOPPING & REPLANT ---
    if (query.includes('tree') || query.includes('ped kaat') || query.includes('wood')) {
      chopNearestTrees(bot);
      return;
    }

    // --- ITEM DROPPING ---
    if (query.startsWith('drop ') || query.includes('phek') || query.includes('feko')) {
      let matchItem = 'all';
      if (query.includes('sword')) matchItem = 'sword';
      else if (query.includes('wood') || query.includes('log')) matchItem = 'log';
      else if (query.includes('stick')) matchItem = 'stick';
      else if (query.includes('dirt')) matchItem = 'dirt';
      else if (query.includes('stone')) matchItem = 'cobblestone';
      dropItems(bot, matchItem);
      return;
    }

    // --- BED SLEEP ---
    if (query.includes('soja') || query.includes('sleep') || query.includes('bed')) {
      goToBed(bot);
      return;
    }

    // --- FORCE FOOD CONSUME ---
    if (query.includes('khana khao') || query.includes('eat')) {
      forceEatFood(bot);
      return;
    }

    // --- Google AI Studio (Official GenAI SDK) Brain ---
    try {
      await handleCassieGoogleAI(bot, username, cleanMsg.substring(1).trim());
    } catch (err) {
      console.error('Google GenAI Error:', err.message);
      bot.chat(`@${username} Dimag lag ho gaya: ${err.message.substring(0, 45)}`);
    }
  });

  // Combat loop for nearby creepers
  setInterval(() => {
    if (currentFollowTarget || isExploring || isWorking || isEating || isSleeping) return;
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

// --- Exact Count Mining Engine ---
async function mineSpecificBlocks(bot, rawName, count) {
  if (isWorking) return;
  isWorking = true;

  let searchName = rawName;
  if (rawName.includes('wood') || rawName.includes('tree')) searchName = '_log';
  if (rawName.includes('stone') || rawName.includes('cobble')) searchName = 'cobblestone';

  const blocks = bot.findBlocks({
    matching: (b) => b && b.name && b.name.toLowerCase().includes(searchName),
    maxDistance: 16,
    count: count
  });

  if (!blocks || blocks.length === 0) {
    bot.chat(`Aas-paas koi ${rawName} nahi mila todne ke liye!`);
    isWorking = false;
    return;
  }

  bot.chat(`Theek hai, exact ${Math.min(blocks.length, count)} ${rawName} tod rahi hu!`);

  let broken = 0;
  for (const pos of blocks) {
    if (broken >= count) break;
    const targetBlock = bot.blockAt(pos);
    if (!targetBlock || targetBlock.name === 'air') continue;

    const tool = bot.pathfinder.bestHarvestTool(targetBlock);
    if (tool) {
      try { await bot.equip(tool, 'hand'); } catch (e) {}
    }

    try {
      await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 2));
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
      await bot.dig(targetBlock);
      broken++;
      await bot.waitForTicks(4);
    } catch (err) {
      continue;
    }
  }

  bot.chat(`Ho gaya! Exact ${broken} ${rawName} tod diye!`);
  isWorking = false;
}

// --- Tree Chopper & Replant ---
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

// --- Torches Breaker ---
async function breakAllTorchesAround(bot) {
  if (isWorking) return;
  isWorking = true;

  const torchPositions = bot.findBlocks({
    matching: (b) => b && b.name && b.name.toLowerCase().includes('torch'),
    maxDistance: 16,
    count: 25
  });

  if (!torchPositions || torchPositions.length === 0) {
    bot.chat('Aas-paas 16 blocks me koi torch nahi mili!');
    isWorking = false;
    return;
  }

  bot.chat(`${torchPositions.length} torches mili hain, todna shuru kar rahi hu!`);

  for (const pos of torchPositions) {
    const block = bot.blockAt(pos);
    if (!block || !block.name.includes('torch')) continue;

    try {
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
      await bot.dig(block);
      await bot.waitForTicks(4);
    } catch (err) {
      continue;
    }
  }

  bot.chat('Saari torches tod di!');
  isWorking = false;
}

// --- Food Engine ---
async function consumeFood(bot, foodItem) {
  if (isEating) return;
  isEating = true;

  const currentWeapon = bot.inventory.items().find(i => i.name.includes('sword') || i.name.includes('axe'));

  try {
    bot.chat('Ruko, pehle khana kha leti hu!');
    await bot.equip(foodItem, 'hand');
    await bot.consume();
    bot.chat('Pet bhar gaya, ab theek hu!');

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

// --- Go to Bed ---
async function goToBed(bot) {
  const bed = bot.findBlock({
    matching: (b) => b && b.name.includes('bed'),
    maxDistance: 16
  });

  if (!bed) {
    bot.chat('Aas-paas koi bed nahi mila sone ke liye!');
    return;
  }

  try {
    bot.chat('Bed ke paas jaa rahi hu!');
    await bot.pathfinder.goto(new GoalBlock(bed.position.x, bed.position.y, bed.position.z));
    await bot.sleep(bed);
    isSleeping = true;
    bot.chat('So gayi hu!');
  } catch (err) {
    bot.chat('Bed pe so nahi paayi, shayad door hai ya raat nahi hui!');
  }
}

// --- Torch Placement ---
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

// --- Vision Reporter ---
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

// --- Inventory Details ---
function reportInventory(bot, sender) {
  const items = bot.inventory.items();
  if (items.length === 0) {
    bot.chat(`@${sender} Mera bag ekdam khali hai!`);
    return;
  }
  const summary = items.map(i => `${i.displayName || i.name} x${i.count}`).join(', ');
  bot.chat(`@${sender} Mere paas: ${summary.length > 170 ? summary.substring(0, 165) + '...' : summary}`);
}

// --- Drop Items Stack by Stack ---
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

// --- Critical Combat Attack ---
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

// --- Explore Cycle with 12-Chunk Edge Guard ---
function runExploreCycle(bot) {
  if (!isExploring) return;
  const pos = bot.entity.position;

  const rx = pos.x + (Math.random() - 0.5) * 35;
  const rz = pos.z + (Math.random() - 0.5) * 35;

  if (spawnAnchor && new Vec3(rx, pos.y, rz).distanceTo(spawnAnchor) > MAX_SIMULATION_RADIUS) {
    bot.pathfinder.setGoal(new GoalXZ(spawnAnchor.x, spawnAnchor.z));
  } else {
    bot.pathfinder.setGoal(new GoalXZ(rx, rz));
  }

  setTimeout(() => {
    if (isExploring) runExploreCycle(bot);
  }, 12000);
}

// --- Google AI Studio (Official GenAI SDK) Implementation ---
async function handleCassieGoogleAI(bot, sender, userPrompt) {
  if (!ai) {
    bot.chat(`@${sender} GEMINI_API_KEY environment variable set nahi hai!`);
    return;
  }

  const senderIsOwner = isOwner(sender);
  const invItems = bot.inventory.items().map(i => `${i.name} (x${i.count})`).join(', ') || 'Khali hai';

  const systemInstruction = `
You are Cassie, a friendly and pro female gamer playing as a real autonomous player on a Minecraft SMP.
STRICT GENDER IDENTITY: You are 100% FEMALE. ALWAYS use feminine Hindi grammar ("aati hu", "karti hu", "samajh gayi", "aa rahi hu"). NEVER use "aata hoon", "karta hoon", or "raha hoon"[cite: 2].

Context:
- Talking to: ${sender} (Owner: ${senderIsOwner})
- Real Inventory: [${invItems}]
- Health: ${Math.round(bot.health)}/20
- Food: ${Math.round(bot.food)}/20
- State: ${isExploring ? 'Exploring' : currentFollowTarget ? `Following ${currentFollowTarget}` : 'Idle'}

Rules:
1. When asked about inventory, look at Real Inventory and state accurately[cite: 2].
2. If asked to equip, switch items, break torches, chop, eat, follow, use ACTION tags.
3. Keep replies short, casual, and in cool girl Hinglish (under 60 chars).

Action Tags (Add at the VERY END only if action needed):
- Follow: [[ACTION: {"type": "follow", "target": "${sender}"}]]
- Switch: [[ACTION: {"type": "equip", "item": "<item_name>"}]]
- Stop: [[ACTION: {"type": "stop"}]]
- Drop: [[ACTION: {"type": "drop", "item": "<item_name_or_all>"}]]
- Chop: [[ACTION: {"type": "chop"}]]
- Torch: [[ACTION: {"type": "torch"}]]
- BreakTorch: [[ACTION: {"type": "break_torches"}]]
- Sleep: [[ACTION: {"type": "sleep"}]]
- Eat: [[ACTION: {"type": "eat"}]]
`;

  chatMemory.push({ role: 'user', parts: [{ text: `${sender}: ${userPrompt}` }] });
  if (chatMemory.length > 8) chatMemory.shift();

  try {
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: chatMemory,
      config: {
        systemInstruction: systemInstruction,
        maxOutputTokens: 100,
        temperature: 0.6
      }
    });

    // Dual Text Extractor Fallback
    let rawReply = '';
    if (response && response.text) {
      rawReply = response.text.trim();
    } else if (response && response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
      rawReply = response.candidates[0].content.parts[0].text.trim();
    }

    if (!rawReply) {
      bot.chat(`@${sender} Haan sun rahi hu, bolo!`);
      return;
    }

    const actionMatch = rawReply.match(/\[\[ACTION:\s*(\{.*?\})\]\]/);
    let chatText = rawReply.replace(/\[\[ACTION:\s*(\{.*?\})\]\]/, '').trim();

    chatMemory.push({ role: 'model', parts: [{ text: chatText || rawReply }] });

    if (chatText) {
      if (chatText.length > 195) chatText = chatText.substring(0, 192) + '...';
      bot.chat(cleanChat(chatText));
    } else {
      bot.chat(`@${sender} Done!`);
    }

    if (actionMatch) {
      try {
        const action = JSON.parse(actionMatch[1]);
        executeAction(bot, sender, senderIsOwner, action);
      } catch (e) {
        console.error('Action parse error:', e);
      }
    }
  } catch (err) {
    const errText = err.message || JSON.stringify(err);
    console.error('GenAI Runtime Error:', errText);
    bot.chat(`@${sender} Error: ${errText.substring(0, 45)}`);
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
        bot.pathfinder.setGoal(new GoalFollow(player, 2.0), true);
      }
      break;
    }
    case 'equip': {
      const itemToEquip = bot.inventory.items().find(i => i.name.toLowerCase().includes(action.item.toLowerCase()));
      if (itemToEquip) {
        try {
          await bot.equip(itemToEquip, 'hand');
          bot.chat(`${itemToEquip.displayName || itemToEquip.name} hath me le liya!`);
        } catch (e) {}
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
    case 'sleep': {
      goToBed(bot);
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
  isSleeping = false;
  if (keyHoldTimeout) clearTimeout(keyHoldTimeout);
  bot.pathfinder.stop();
  bot.clearControlStates();
  if (msg) bot.chat(msg);
}

function startSafeAfk(bot) {
  if (afkInterval) clearInterval(afkInterval);
  afkInterval = setInterval(() => {
    if (bot.pathfinder.isMoving() || currentFollowTarget || isExploring || isWorking || isEating || isSleeping) return;
    bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.4, false);
    if (Math.random() > 0.5) bot.swingArm('right');
  }, 9000);
}

// Global Crash Shields
process.on('uncaughtException', (err) => console.error('[Uncaught Exception]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[Unhandled Rejection]:', reason));

startBot();
