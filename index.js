const express = require('express');
const mineflayer = require('mineflayer');

const app = express();
app.get('/', (req, res) => res.send('Bot zinda hai bhai!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Render web server running on port ${PORT}...`));

// Ye kisi bhi error ko Render crash karne se rokega
process.on('uncaughtException', (err) => {
  console.log('Bada Error (Crash bacha liya):', err.message);
});
process.on('unhandledRejection', (err) => {
  console.log('Promise Error (Crash bacha liya):', err.message);
});

let bot;
let lastActivity = Date.now();
let spawnTime = Date.now();
let watchdog;

function startBot() {
  console.log('Connecting to Minecraft...');
  
  try {
    bot = mineflayer.createBot({
      host: 'TUMHARA_ATERNOS_IP.aternos.me', // <-- YAHAN APNA ASLI IP DAALNA
      username: '247_aalu_khalo',
      version: false
    });
  } catch (err) {
    console.log('Start hone me error:', err.message);
    setTimeout(startBot, 5000);
    return;
  }

  bot.on('spawn', () => {
    console.log('Bot spawn ho gaya! 😎');
    lastActivity = Date.now();
    spawnTime = Date.now(); 

    setInterval(() => {
      const actions = ['forward', 'back', 'left', 'right', 'jump'];
      const action = actions[Math.floor(Math.random() * actions.length)];
      bot.setControlState(action, true);
      setTimeout(() => bot.setControlState(action, false), 500);
      bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * Math.PI);
    }, 5000); 
  });

  bot.on('move', () => {
    lastActivity = Date.now();
  });

  watchdog = setInterval(() => {
    if (!bot || !bot.entity) return; // Agar bot abhi tak spawn nahi hua toh wait karo
    
    const now = Date.now();
    if (now - lastActivity > 30000) {
      console.log('30s se koi movement nahi, restarting... 🥀');
      clearInterval(watchdog);
      bot.quit();
    } 
    else if (now - spawnTime > 60000) {
      console.log('60s ho gaye hain, force rejoin maar raha hu... 😎');
      clearInterval(watchdog);
      bot.quit();
    }
  }, 5000); 

  bot.on('end', () => {
    if (watchdog) clearInterval(watchdog); 
    console.log('Connection closed! 5s mein wapas try kar raha hu... 💔');
    setTimeout(startBot, 5000);
  });

  bot.on('error', (err) => {
    console.log('Error aaya:', err.message);
    if (watchdog) clearInterval(watchdog);
    bot.quit();
  });
}

startBot();
