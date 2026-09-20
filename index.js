const mineflayer = require('mineflayer');
const express = require('express');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow } = goals;

// --- Web Server (Keep Alive) ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Cassie is Online with GPT-4o-mini!'));
app.listen(port, () => console.log(`[Web] Listening on port ${port}`));

// --- Configurations ---
const SERVER_IP = 'YSsmpontop.aternos.me';
const BOT_USERNAME = 'Cassie';
const VERSION = '1.20.4';
const DEFAULT_SKIN = 'chloepowell';

// Dono Owners
const OWNERS = ['NotGamerSpark', 'DusraOwnerUsername'].map(o => o.toLowerCase());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL_NAME = 'openai/gpt-6-astra';

let afkInterval = null;
let currentFollowTarget = null;
let isReconnecting = false;
let chatMemory = [];

function isOwner(username) {
  return username && OWNERS.includes(username.toLowerCase());
}

function startBot() {
  console.log(`[Connect] Cassie connecting to ${SERVER_IP}...`);
  isReconnecting = false;

  const bot = mineflayer.createBot({
    host: SERVER_IP,
    username: BOT_USERNAME,
    version: VERSION
  });

  bot.loadPlugin(pathfinder);

  // 1. Spawn Event
  bot.on('spawn', () => {
    console.log(`✅ ${bot.username} server me join ho chuki hai!`);

    try {
      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);

      // Smooth Movement for Slabs & Fences
      defaultMove.canDig = false;
      defaultMove.allowParkour = true;
      defaultMove.allowSprinting = true;
      defaultMove.canOpenDoors = true;
      defaultMove.maxDropDown = 4;
      defaultMove.liquidCost = 25;
      defaultMove.entityCost = 0;

      bot.pathfinder.setMovements(defaultMove);
    } catch (e) {
      console.error('[Movements Error]:', e.message);
    }

    setTimeout(() => bot.chat(`/skin ${DEFAULT_SKIN}`), 3500);
    startSafeAfk(bot);
  });

  // 2. Auto-Respawn
  bot.on('death', () => {
    console.log('💀 Cassie mar gayi! 2 sec me respawn...');
    stopAll(bot);
    setTimeout(() => {
      try { bot.respawn(); } catch (e) {}
    }, 2000);
  });

  // 3. Smart Slab/Block Auto Jump
  bot.on('physicsTick', () => {
    if (!currentFollowTarget) return;

    const target = bot.players[currentFollowTarget]?.entity;
    if (!target) return;

    const dist = bot.entity.position.distanceTo(target.position);

    if (dist <= 2.2) {
      bot.clearControlStates();
      return;
    }

    if (bot.entity.isCollidedHorizontally) {
      bot.setControlState('jump', true);
    } else {
      bot.setControlState('jump', false);
    }
  });

  // 4. Chat & Command Router
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    const cleanMsg = message.trim();

    // Owner Console Commands (!cmd <command>)
    if (cleanMsg.startsWith('!cmd ')) {
      if (!isOwner(username)) {
        bot.chat(`@${username} Sirf owner console commands chala sakte hain!`);
        return;
      }
      bot.chat(cleanMsg.replace('!cmd ', '').trim());
      return;
    }

    // Immediate Stop Command
    if (cleanMsg === '!stop' || cleanMsg.toLowerCase() === '!cassie stop') {
      if (isOwner(username) || currentFollowTarget === username) {
        stopAll(bot, 'Ruk gayi!');
      }
      return;
    }

    // Only process queries starting with '!'
    if (!cleanMsg.startsWith('!')) return;
    const query = cleanMsg.substring(1).trim().toLowerCase();
    if (!query) return;

    // --- ZERO-API INSTANT FOLLOW SHORTCUT ---
    if (query.includes('pass aa') || query.includes('follow') || query.includes('aaja') || query.includes('mere pass')) {
      const player = bot.players[username]?.entity;
      if (player) {
        currentFollowTarget = username;
        bot.pathfinder.setGoal(new GoalFollow(player, 2.0), true);
        bot.chat(`Aa rahi hu @${username}!`);
      } else {
        bot.chat(`@${username} Tu render range me nahi dikh raha, thoda paas aa!`);
      }
      return;
    }

    // OpenRouter AI Call
    try {
      await handleCassieAI(bot, username, cleanMsg.substring(1).trim());
    } catch (err) {
      console.error('[OpenRouter Error]:', err.response?.data || err.message);
      bot.chat(`@${username} Dimag thoda lag ho gaya, wapas bol!`);
    }
  });

  // 5. Anti-Crash & Slow Safe Reconnect
  bot.on('kicked', (reason) => console.log(`[Kicked]: ${reason}`));

  bot.on('end', () => {
    if (isReconnecting) return;
    isReconnecting = true;

    console.log('🔴 Disconnected from Aternos. 25 seconds cooldown...');
    if (afkInterval) clearInterval(afkInterval);
    stopAll(bot);

    setTimeout(() => {
      startBot();
    }, 25000);
  });

  bot.on('error', (e) => console.error('[Bot Error]:', e.message));
}

// --- AI Brain (OpenRouter GPT-4o-mini) ---
async function handleCassieAI(bot, sender, userPrompt) {
  if (!OPENROUTER_API_KEY) {
    bot.chat(`@${sender} OPENROUTER_API_KEY set nahi hai!`);
    return;
  }

  const senderIsOwner = isOwner(sender);
  const invItems = bot.inventory.items().map(i => `${i.name} (x${i.count})`).join(', ') || 'Khali';

  const systemPrompt = `
You are Cassie, a friendly female human gamer playing on a Minecraft SMP.
STRICT GENDER IDENTITY: You are 100% FEMALE. ALWAYS use feminine Hindi grammar ("aati hu", "karti hu", "samajh gayi", "aa rahi hu"). NEVER use "aata hoon" or "karta hoon"[cite: 2].
Current Status:
- Talking to: ${sender} (Owner: ${senderIsOwner})
- Your Real Inventory: [${invItems}]
- Health: ${Math.round(bot.health)}/20
Keep responses strictly under 60 characters in cool girl Hinglish.
`;

  chatMemory.push({ role: 'user', content: `${sender}: ${userPrompt}` });
  if (chatMemory.length > 6) chatMemory.shift();

  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: MODEL_NAME,
      messages: [{ role: 'system', content: systemPrompt }, ...chatMemory],
      max_tokens: 70,
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

  const replyText = response.data?.choices?.[0]?.message?.content?.trim();
  if (replyText) {
    chatMemory.push({ role: 'assistant', content: replyText });
    const cleanOutput = replyText.length > 200 ? replyText.substring(0, 197) + '...' : replyText;
    bot.chat(cleanOutput);
  }
}

function stopAll(bot, msg) {
  currentFollowTarget = null;
  bot.pathfinder.stop();
  bot.clearControlStates();
  if (msg) bot.chat(msg);
}

// --- Safe AFK Loop ---
function startSafeAfk(bot) {
  if (afkInterval) clearInterval(afkInterval);
  afkInterval = setInterval(() => {
    if (bot.pathfinder.isMoving() || currentFollowTarget) return;
    bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.4, false);
    if (Math.random() > 0.5) bot.swingArm('right');
  }, 9000);
}

// Global Process Crash Shield
process.on('uncaughtException', (err) => console.error('[Uncaught Exception]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[Unhandled Rejection]:', reason));

startBot();
