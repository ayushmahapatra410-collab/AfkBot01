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

// Error aane par safely disconnect karne ke liye function
function safeDisconnect() {
  if (bot) {
    if (typeof bot.quit === 'function') {
      bot.quit();
    } else if (typeof bot.end === 'function') {
      bot.end();
    }
  }
}

function startBot() {
  console.log('Connecting to Minecraft...');
  
  try {
    bot = mineflayer.createBot({
      // ATERNOS PANEL SE 'CONNECT' WALI DYNAMIC IP DAALO (Bina port ke)
      host: 'blackbear.aternos.host', 
      
      // COLON (:) KE BAAD WALA PORT NUMBER YAHAN DAALO
      port: 26267,                  
      
      username: '247_aalu_khalo',
      
      // Agar tumhare latest snapshot (jaise 26.1) par version: false error de, 
      // toh isko change karke exact version string daal dena (jaise '1.21')
      version: 1.20.4 
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

    // Anti-AFK Random Movement (Har 5 sec)
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

  // Dual Watchdog Loop (Har 5 sec me check karega)
  watchdog = setInterval(() => {
    if (!bot || !bot.entity) return; // Jab tak bot spawn na ho tab tak wait 
    
    const now = Date.now();
    
    // Condition 1: 30s se atka hua hai
    if (now - lastActivity > 30000) {
      console.log('30s se koi movement nahi, restarting... 🥀');
      clearInterval(watchdog);
      safeDisconnect();
    } 
    // Condition 2: 60s tak zinda reh liya, ab session fresh karo
    else if (now - spawnTime > 60000) {
      console.log('60s ho gaye hain, force rejoin maar raha hu... 😎');
      clearInterval(watchdog);
      safeDisconnect();
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
    safeDisconnect(); 
  });
}

startBot();
