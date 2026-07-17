const express = require('express');
const mineflayer = require('mineflayer');

const app = express();
app.get('/', (req, res) => res.send('Bot zinda hai bhai!'));
app.listen(3000, () => console.log('Render web server running...'));

function startBot() {
  console.log('Connecting to Minecraft...');
  const bot = mineflayer.createBot({
    host: 'berozgar_ultra18.aternos.me', // Yahan apna server IP daalo
    username: '247_aalu_khalo',
    version: false // Agar version error aaye toh apna exact version daal dena
  });

  bot.on('spawn', () => {
    console.log('Bot zinda ho gaya aur server me aa gaya! 😎');
    
    // Anti-AFK Logic (Random Movement)
    setInterval(() => {
      const actions = ['forward', 'back', 'left', 'right', 'jump'];
      const action = actions[Math.floor(Math.random() * actions.length)];
      bot.setControlState(action, true);
      setTimeout(() => bot.setControlState(action, false), 500);
      bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * Math.PI);
    }, 10000); // Har 10 second me random hilega
  });

  // Agar kick ho ya server band ho, toh dobara try karega
  bot.on('end', () => {
    console.log('Connection toot gaya! 5 second me wapas try kar raha hu... 💔');
    setTimeout(startBot, 5000); 
  });

  bot.on('error', (err) => {
    console.log('Error aaya:', err);
  });
}

startBot();
