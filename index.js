const express = require('express');
const mineflayer = require('mineflayer');

const app = express();
app.get('/', (req, res) => res.send('Bot zinda hai bhai!'));
app.listen(3000, () => console.log('Render web server running...'));

let bot;
let lastActivity = Date.now();
let spawnTime = Date.now();
let watchdog;

function startBot() {
  console.log('Connecting to Minecraft...');
  bot = mineflayer.createBot({
    host: 'berozgar_ultra18.aternos.me', // Yahan IP sahi se daalna
    username: '247_aalu_khalo',
    version: false
  });

  bot.on('spawn', () => {
    console.log('Bot spawn ho gaya! 😎');
    lastActivity = Date.now();
    spawnTime = Date.now(); // Jab bot server me aaya uska time

    // Anti-AFK Random Movement
    setInterval(() => {
      const actions = ['forward', 'back', 'left', 'right', 'jump'];
      const action = actions[Math.floor(Math.random() * actions.length)];
      bot.setControlState(action, true);
      setTimeout(() => bot.setControlState(action, false), 500);
      bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * Math.PI);
    }, 5000); // Har 5 second me kuch harkat karega
  });

  // Activity tracker (Movement)
  bot.on('move', () => {
    lastActivity = Date.now();
  });

  // Dual Watchdog Loop
  watchdog = setInterval(() => {
    const now = Date.now();
    
    // Condition 1: Agar 30 sec tak koi movement NAHI hui (Atak gaya)
    if (now - lastActivity > 30000) {
      console.log('30s se koi movement nahi, atak gaya hai, restarting... 🥀');
      clearInterval(watchdog);
      bot.quit();
    } 
    // Condition 2: Agar move kar raha hai, par join kiye 60 sec ho gaye (Force Rejoin)
    else if (now - spawnTime > 60000) {
      console.log('60s ho gaye hain, session fresh karne ke liye force rejoin maar raha hu... 😎');
      clearInterval(watchdog);
      bot.quit();
    }
  }, 5000); // Har 5 second me check karega

  bot.on('end', () => {
    if (watchdog) clearInterval(watchdog); // Purane timer ko band karo
    console.log('Connection closed! 5s mein wapas try kar raha hu... 💔');
    setTimeout(startBot, 5000);
  });

  bot.on('error', (err) => {
    console.log('Error aaya:', err);
    if (watchdog) clearInterval(watchdog);
    bot.quit();
  });
}

startBot();
