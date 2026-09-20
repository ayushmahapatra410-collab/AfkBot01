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

// Dono Owners
const OWNERS = ['NotGamerSpark', 'DusraOwnerUsername'].map(o => o.toLowerCase());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL_NAME = 'qwen/qwen-2.5-72b-instruct:free';

let afkInterval = null;
let currentFollowTarget = null;
let isExploring = false;
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
    try {
      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);

      defaultMove.canDig = false;
      defaultMove.allowParkour = true;
      defaultMove.allowSprinting = true;
      defaultMove.canOpenDoors = true;
      defaultMove.maxDropDown = 3;
      defaultMove.liquidCost = 30;
      defaultMove.entityCost = 0;

      bot.pathfinder.setMovements(defaultMove);
    } catch (e) {
      console.error('Movement setup error:', e.message);
    }

    setTimeout(() => {
      bot.chat(`/skin ${DEFAULT_SKIN}`);
    }, 3000);

    startSafeAfk(bot);
  });

  bot.on('death', () => {
    logGameEvent('Mar gayi!');
    currentFollowTarget = null;
    isExploring = false;
    setTimeout(() => bot.respawn(), 2000);
  });

  // Direct follow movement & auto-jump on slabs
  bot.on('physicsTick', () => {
    if (!currentFollowTarget) return;

    const target = bot.players[currentFollowTarget]?.entity;
    if (!target) return;

    const dist = bot.entity.position.distanceTo(target.position);

    if (dist <= 2.2) {
      bot.clearControlStates();
      return;
    }

    // Direct walk agar dikh raha ho
    if (bot.canSeeEntity(target)) {
      bot.lookAt(target.position.offset(0, target.height * 0.85, 0), true);
      bot.setControlState('forward', true);
      bot.setControlState('sprint', dist > 4);

      if (bot.entity.isCollidedHorizontally) {
        bot.setControlState('jump', true);
      } else {
        bot.setControlState('jump', false);
      }
    } else {
      if (bot.entity.isCollidedHorizontally) {
        bot.setControlState('jump', true);
      } else {
        bot.setControlState('jump', false);
      }
    }
  });

  // Chat Router
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    const cleanMsg = message.trim();

    // 1. Direct Console Command (!cmd <command>)
    if (cleanMsg.startsWith('!cmd ')) {
      if (!isOwner(username)) {
        bot.chat(`@${username} Sirf owner console commands chala sakte hain!`);
        return;
      }
      bot.chat(cleanMsg.replace('!cmd ', '').trim());
      return;
    }

    // 2. Direct Stop Command
    if (cleanMsg === '!stop' || cleanMsg.toLowerCase() === '!cassie stop') {
      if (isOwner(username) || currentFollowTarget === username) {
        stopAll(bot, 'Ruk gayi, sab cancel!');
      }
      return;
    }

    // Prefix check
    if (!cleanMsg.startsWith('!')) return;
    const query = cleanMsg.substring(1).trim().toLowerCase();
    if (!query) return;

    // 3. FAST SHORTCUT: Agar follow/pass aane ko bole, to AI wait mat karvao (instant follow)
    if (query.includes('pass aa') || query.includes('follow') || query.includes('aaja') || query.includes('mere pass')) {
      isExploring = false;
      const player = bot.players[username]?.entity;
      if (player) {
        currentFollowTarget = username;
        bot.pathfinder.setGoal(new GoalFollow(player, 2.0), true);
        bot.chat(`Aayi @${username}!`);
      } else {
        bot.chat(`@${username} Tu render range me nahi hai, thoda samne aa!`);
      }
      return;
    }

    // 4. Normal Chat ke liye OpenRouter Call
    try {
      await handleCassieAI(bot, username, cleanMsg.substring(1).trim());
    } catch (err) {
      console.error('AI Error details:', err.response?.data || err.message);
      bot.chat(`@${username} API issue ho gaya, key check karo!`);
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

  bot.on('end', (reason) => {
    console.log(`Disconnected (${reason}). Reconnecting in 20s...`);
    if (afkInterval) clearInterval(afkInterval);
    currentFollowTarget = null;
    isExploring = false;
    setTimeout(startBot, 20000);
  });

  bot.on('error', (e) => console.error('Bot Error:', e.message));
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

// --- AI Handler ---
async function handleCassieAI(bot, sender, userPrompt) {
  if (!OPENROUTER_API_KEY) {
    bot.chat(`@${sender} OpenRouter API key missing hai!`);
    return;
  }

  const senderIsOwner = isOwner(sender);
  const botPos = bot.entity.position;
  const invItems = bot.inventory.items().map(i => `${i.name} (x${i.count})`).join(', ') || 'Khali hai';

  const systemPrompt = `
You are Cassie, a female Minecraft player on an SMP.
STRICT FEMININE TONE: ALWAYS use feminine Hindi words ("aati hu", "karti hu", "samajh gayi").
Current Status:
- Talking to: ${sender} (Owner: ${senderIsOwner})
- Inventory: [${invItems}]
- Health: ${Math.round(bot.health)}/20
Keep responses short, chill, and in Hinglish (under 60 chars).
`;

  chatMemory.push({ role: 'user', content: `${sender}: ${userPrompt}` });
  if (chatMemory.length > 6) chatMemory.shift();

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
      timeout: 8000 // 8s timeout taaki bot freeze na ho
    }
  );

  const replyText = response.data?.choices?.[0]?.message?.content?.trim();
  if (replyText) {
    chatMemory.push({ role: 'assistant', content: replyText });
    bot.chat(replyText.length > 200 ? replyText.substring(0, 197) + '...' : replyText);
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

// Global crash protection
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

startBot();
