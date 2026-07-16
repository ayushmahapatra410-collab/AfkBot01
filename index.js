const mineflayer = require('mineflayer');
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Ye web server bot ko zinda rakhega
app.get('/', (req, res) => res.send('Bot is Running 24/7!'));
app.listen(port, () => console.log(`Web server listening on port ${port}`));

// --- Configuration ---
const SERVER_IP = 'berozgar_ultra18.aternos.me'; // Apna Aternos IP dalo
const BOT_USERNAME = '247_aalu_khalo';             
const VERSION = '1.20.4';                   // Apna version dalo

function startBot() {
  console.log(`Connecting to ${SERVER_IP}...`);
  
  const bot = mineflayer.createBot({
    host: SERVER_IP,
    username: BOT_USERNAME,
    version: VERSION
  });

  bot.on('login', () => {
    console.log(`✅ ${bot.username} successfully joined the server!`);
    setInterval(() => {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 1000);
      bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * Math.PI);
    }, 15000); 
  });

  bot.on('end', () => {
    console.log('🔴 Disconnected. Attempting to reconnect in 10 seconds...');
    setTimeout(startBot, 10000);
  });

  bot.on('error', (err) => console.error(`❌ Error: ${err.message}`));
}

startBot();
