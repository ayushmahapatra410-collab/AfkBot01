const mineflayer = require('mineflayer');
const express = require('express');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow } = goals;

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

    // Movements fix taaki slab par path drop na ho
    defaultMove.canDig = false;           
    defaultMove.allowParkour = true;      
    defaultMove.allowSprinting = true;    
    defaultMove.canOpenDoors = true;      
    defaultMove.maxDropDown = 5;          
    defaultMove.liquidCost = 25;
    defaultMove.entityCost = 0; // Entity ko block na mane

    bot.pathfinder.setMovements(defaultMove);

    setTimeout(() => bot.chat(`/skin ${DEFAULT_SKIN}`), 3000);
    startSafeAfk(bot);
  });

  bot.on('death', () => {
    logGameEvent('Mar gayi!');
    currentFollowTarget = null;
    isExploring = false;
    setTimeout(() => bot.respawn(), 2000);
  });

  // SLAB & MANUAL OVERRIDE ENGINE (Physics Tick)
  bot.on('physicsTick', () => {
    if (!currentFollowTarget) return;

    const target = bot.players[currentFollowTarget]?.entity;
    if (!target) return;

    const dist = bot.entity.position.distanceTo(target.position);

    // Agar 2 blocks ke andar hai toh aaram se khadi rahe
    if (dist <= 2.2) {
      bot.clearControlStates();
      return;
    }

    // DIRECT LINE OF SIGHT OVERRIDE
    // Agar samne player dikh raha hai (chahe raste me slab ho), pathfinder ko dump karo aur seedha aage bado
    if (bot.canSeeEntity(target)) {
      // Direct look at player
      bot.lookAt(target.position.offset(0, target.height * 0.85, 0), true);
      bot.setControlState('forward', true);
      bot.setControlState('sprint', dist > 4);

      // Check karo ki aage slab/block par atki hai kya
      const isStuckOrCollided = bot.entity.isCollidedHorizontally;
      const blockInFront = bot.blockAtCursor(1.5);
      const isSlabAhead = blockInFront && blockInFront.name.includes('slab');

      // Agar samne slab hai ya body takra rahi hai toh direct jump do bina peeche ghoome
      if (isStuckOrCollided || isSlabAhead) {
        bot.setControlState('jump', true);
      } else {
        bot.setControlState('jump', false);
      }
    } else {
      // Agar player samne nahi dikh raha (deewar ke peeche hai), tab auto jump on collision
      if (bot.entity.isCollidedHorizontally) {
        bot.setControlState('jump', true);
      } else {
        bot.setControlState('jump', false);
      }
    }
  });

  // Pathfinder ko faltu rasta cancel karne se roko agar player visible hai
  bot.on('path_reset', (reason) => {
    if (currentFollowTarget && reason === 'noPath') {
      const target = bot.players[currentFollowTarget]?.entity;
      if (!target || !bot.canSeeEntity(target)) {
        bot.chat(`@${currentFollowTarget} Rasta nahi mil raha, thoda aage aao!`);
        currentFollowTarget = null;
        bot.pathfinder.stop();
      }
      // Agar target visible hai to pathfinder ko ignore karega aur physicsTick seedha walk karwayega
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
    if (isOwner(username) && (cleanMsg === '!stop' || cleanMsg.toLowerCase() === '!cassie stop')) {
      stopAll(bot, 'Ruk gayi, sab cancel!');
      return;
    }

    // Chat Prefix '!'
    if (!cleanMsg.startsWith('!')) return;
    const query = cleanMsg.substring(1).trim();
    if (!query) return;

    try {
      await handleCassieAI(bot, username, query);
    } catch (err) {
      console.error('AI Error:', err.message);
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

  bot.on('end', () => {
    if (afkInterval) clearInterval(afkInterval);
    currentFollowTarget = null;
    isExploring = false;
    setTimeout(startBot, 25000);
  });

  bot.on('error', (e) => console.error(e.message));
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

// --- AI Brain (Strict Female Persona & Inventory Check) ---
async function handleCassieAI(bot, sender, userPrompt) {
  const senderIsOwner = isOwner(sender);
  const botPos = bot.entity.position;

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
2. If asked to follow, come, or move close ("aaja", "pass aa", "follow", "chalo"), select follow. NEVER select explore[cite: 2].
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
        bot.pathfinder.setGoal(new GoalFollow(player, 2.0), true);
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

// --- Explore Cycle ---
function runExploreCycle(bot) {
  if (!isExploring) return;
  const pos = bot.entity.position;
  const rx = pos.x + (Math.random() - 0.5) * 30;
  const rz = pos.z + (Math.random() - 0.5) * 30;
  bot.pathfinder.setGoal(new GoalFollow({ position: bot.entity.position.offset(rx - pos.x, 0, rz - pos.z) }, 1));

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

startBot();
