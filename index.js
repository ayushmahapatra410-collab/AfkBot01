const mineflayer = require('mineflayer');
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Keep-alive web server
app.get('/', (req, res) => res.send('Bot is Running 24/7!'));
app.listen(port, () => console.log(`Web server listening on port ${port}`));

// --- Configuration ---
const SERVER_IP = 'YSsmpontop.aternos.me';
const BOT_USERNAME = 'AFK_Bot';
const VERSION = '1.20.4';

let afkInterval = null;

function startBot() {
  console.log(`Connecting to ${SERVER_IP}...`);

  const bot = mineflayer.createBot({
    host: SERVER_IP,
    username: BOT_USERNAME,
    version: VERSION
  });

  // 1. Spawn hone par natural movement loop shuru karein
  bot.on('spawn', () => {
    console.log(`✅ ${bot.username} server me spawn ho gaya!`);

    if (afkInterval) clearInterval(afkInterval);

    // Human-like random movement (Aternos anti-AFK detection se bachne ke liye)
    afkInterval = setInterval(() => {
      const actions = ['forward', 'back', 'left', 'right', 'jump', 'sneak'];
      const randomAction = actions[Math.floor(Math.random() * actions.length)];

      // Random direction me move kare
      bot.setControlState(randomAction, true);

      // Random head movement (nazar ghumana)
      const yaw = Math.random() * Math.PI * 2;
      const pitch = (Math.random() - 0.5) * (Math.PI / 2);
      bot.look(yaw, pitch, false);

      // Random swing arm (haath hilana)
      if (Math.random() > 0.5) {
        bot.swingArm('right');
      }

      // 500ms se 1.5s ke beech action stop karega taaki movement robotic na lage
      const actionDuration = 500 + Math.random() * 1000;
      setTimeout(() => {
        bot.clearControlStates();
      }, actionDuration);

    }, 8000 + Math.random() * 5000); // 8-13 seconds ka dynamic gap
  });

  // 2. Marne par auto-respawn
  bot.on('death', () => {
    console.log('💀 Bot mar gaya! Respawn ho raha hai...');
    setTimeout(() => {
      bot.respawn();
    }, 2000);
  });

  // 3. Kick ya disconnect hone par proper cleanup aur slow reconnect
  bot.on('kicked', (reason) => {
    console.log(`⚠️ Kick ho gaya: ${reason}`);
  });

  bot.on('end', () => {
    console.log('🔴 Connection cut gaya. 30 seconds baad reconnect hoga...');
    if (afkInterval) clearInterval(afkInterval);
    // Jaldi-jaldi reconnect karne se IP ban ya detection ka risk hota hai
    setTimeout(startBot, 30000);
  });

  bot.on('error', (err) => {
    console.error(`❌ Error: ${err.message}`);
  });
}

startBot();
