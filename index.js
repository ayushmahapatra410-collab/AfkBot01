const mineflayer = require('mineflayer');
const express = require('express');
const axios = require('axios');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalFollow, GoalNear } = goals;

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Smart AI Bot is Alive!'));
app.listen(port, () => console.log(`Web server running on port ${port}`));

// --- Configurations ---
const SERVER_IP = 'YSsmpontop.aternos.me';
const BOT_USERNAME = 'Smart_AI_Bot';
const VERSION = '1.20.4';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'YOUR_OPENROUTER_API_KEY';
const MODEL_NAME = 'openai/gpt-4o-mini'; // Ya 'meta-llama/llama-3.3-70b-instruct'

let afkInterval = null;

function startBot() {
  console.log(`Connecting to ${SERVER_IP}...`);

  const bot = mineflayer.createBot({
    host: SERVER_IP,
    username: BOT_USERNAME,
    version: VERSION
  });

  // Pathfinder plugin load karein (navigation ke liye)
  bot.loadPlugin(pathfinder);

  bot.on('spawn', () => {
    console.log(`✅ ${bot.username} spawned in world!`);
    const mcData = require('minecraft-data')(bot.version);
    const defaultMove = new Movements(bot, mcData);
    bot.pathfinder.setMovements(defaultMove);

    // Natural human-like AFK routine
    startNaturalMovement(bot);
  });

  // 1. Auto Respawn
  bot.on('death', () => {
    console.log('💀 Bot mar gaya! Respawning in 2s...');
    setTimeout(() => bot.respawn(), 2000);
  });

  // 2. Chat Listener & OpenRouter Integration
  bot.on('chat', async (username, message) => {
    // Apne hi messages ignore kare
    if (username === bot.username) return;

    // Sirf tab respond kare jab koi bot ko tag kare ya directly baat kare
    const cleanMsg = message.trim();
    const isMentioned = cleanMsg.toLowerCase().includes(bot.username.toLowerCase()) || cleanMsg.startsWith('!');

    if (!isMentioned) return;

    console.log(`💬 [Chat] ${username}: ${cleanMsg}`);

    // Processing response via OpenRouter
    try {
      await handleAIInteraction(bot, username, cleanMsg);
    } catch (err) {
      console.error('Error handling AI chat:', err.message);
      bot.chat(`@${username} Mera dimag thoda atak gaya tha, kya bole wapas bolna?`);
    }
  });

  bot.on('end', () => {
    console.log('🔴 Disconnected. 25s baad reconnect karega...');
    if (afkInterval) clearInterval(afkInterval);
    setTimeout(startBot, 25000);
  });

  bot.on('error', (err) => console.error(`❌ Error: ${err.message}`));
}

// --- OpenRouter AI Handler (Brain) ---
async function handleAIInteraction(bot, username, userMessage) {
  const player = bot.players[username]?.entity;
  
  // Bot ka surrounding state collect karein
  const botPos = bot.entity.position;
  const botHealth = Math.round(bot.health);
  const botFood = Math.round(bot.food);

  const systemPrompt = `
You are an intelligent Minecraft companion player named ${bot.username}.
You are playing on a survival SMP with other players.
You speak naturally in friendly Hinglish (mix of Hindi + English) or English as appropriate.
Keep your chat messages concise (under 80 characters when possible) so it fits in Minecraft chat without flooding.

Current Game State:
- Bot Health: ${botHealth}/20
- Bot Food: ${botFood}/20
- Bot Position: X=${Math.round(botPos.x)}, Y=${Math.round(botPos.y)}, Z=${Math.round(botPos.z)}
- Talking Player: ${username}

You can perform in-game actions by including special JSON command tags at the VERY END of your message if the user asks you to do something:
- To follow the player: [[ACTION: {"type": "follow", "target": "${username}"}]]
- To stop following or clear tasks: [[ACTION: {"type": "stop"}]]
- To jump: [[ACTION: {"type": "jump"}]]
- To say health/status: Just answer in chat.
- To look around or swing: [[ACTION: {"type": "look_at_player", "target": "${username}"}]]

If no action is needed, do not attach [[ACTION:...]].
Example Response:
"Aaya bro, ruko tere paas aa raha hu! [[ACTION: {"type": "follow", "target": "${username}"}]]"
`;

  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: MODEL_NAME,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${username}: ${userMessage}` }
      ],
      max_tokens: 150,
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

  // Action tag parse karna
  const actionMatch = rawReply.match(/\[\[ACTION:\s*(\{.*?\})\]\]/);
  let chatText = rawReply.replace(/\[\[ACTION:\s*(\{.*?\})\]\]/, '').trim();

  // Minecraft chat me bhejna
  if (chatText) {
    // 256 char limit handle karna
    if (chatText.length > 200) chatText = chatText.substring(0, 197) + '...';
    bot.chat(chatText);
  }

  // Action execute karna
  if (actionMatch) {
    try {
      const action = JSON.parse(actionMatch[1]);
      executeBotAction(bot, action, username);
    } catch (e) {
      console.error('Failed to parse action JSON:', e);
    }
  }
}

// --- Action Executor ---
function executeBotAction(bot, action, defaultTarget) {
  const targetName = action.target || defaultTarget;
  const targetPlayer = bot.players[targetName]?.entity;

  switch (action.type) {
    case 'follow':
      if (targetPlayer) {
        console.log(`Following player: ${targetName}`);
        bot.pathfinder.setGoal(new GoalFollow(targetPlayer, 2), true);
      } else {
        bot.chat(`Tu mujhe dikh nahi raha ${targetName}, paas to aa!`);
      }
      break;

    case 'stop':
      console.log('Stopping all actions');
      bot.pathfinder.stop();
      bot.clearControlStates();
      break;

    case 'jump':
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 500);
      break;

    case 'look_at_player':
      if (targetPlayer) {
        bot.lookAt(targetPlayer.position.offset(0, 1.6, 0));
      }
      break;

    default:
      console.log('Unknown action:', action);
  }
}

// --- Anti-AFK Human Movement ---
function startNaturalMovement(bot) {
  if (afkInterval) clearInterval(afkInterval);

  afkInterval = setInterval(() => {
    // Agar bot abhi pathfind/chase kar raha hai to beech me jump mat karwana
    if (bot.pathfinder.isMoving()) return;

    const moves = ['forward', 'back', 'left', 'right', 'jump', 'sneak'];
    const randomMove = moves[Math.floor(Math.random() * moves.length)];

    bot.setControlState(randomMove, true);

    const yaw = Math.random() * Math.PI * 2;
    const pitch = (Math.random() - 0.5) * 0.8;
    bot.look(yaw, pitch, false);

    if (Math.random() > 0.6) {
      bot.swingArm('right');
    }

    setTimeout(() => {
      bot.clearControlStates();
    }, 600 + Math.random() * 800);

  }, 10000 + Math.random() * 6000);
}

startBot();
