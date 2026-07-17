const mineflayer = require('mineflayer');
const express = require('express');

// --- UptimeRobot ke liye Web Server ---
const app = express();
app.get('/', (req, res) => res.send('Bot is running 24/7!'));
app.listen(3000, () => console.log('Web server is running on port 3000'));

// --- Bot ka Setup ---
const serverIP = "berozgar_ultra18.aternos.me"; // YAHAN APNE ATERNOS SERVER KA IP DAALNA MAT BHULNA!
const botName = "247_aalu_khalo";

function createBot() {
    console.log("Connecting to Minecraft...");
    
    const bot = mineflayer.createBot({
        host: serverIP,
        username: botName,
        // version: "1.20.4" // Agar version ka error aaye toh aage ke do '//' hata kar apna exact version daal dena
    });

    // 1. Jab bot successfully server me aa jaye
    bot.on('spawn', () => {
        console.log("Bot zinda ho gaya aur server me aa gaya! 😎");
        startSmartMovement(bot);
    });

    // 2. Welcome Message (Jab koi dost join kare)
    bot.on('playerJoined', (player) => {
        // Bot khud ko welcome na kare, isiliye ye check lagaya hai
        if (player.username !== bot.username) {
            setTimeout(() => {
                bot.chat(`Hii Hello ${player.username}! Welcome to the server ✌️`);
            }, 3000); // Player ke aane ke 3 second baad bolega taaki real lage
        }
    });

    // 3. Smart Anti-AFK (Insaan jaisi harqatein with Math.random)
    function startSmartMovement(bot) {
        setInterval(() => {
            // Random time generate karega 10 se 35 seconds ke beech
            const randomDelay = Math.floor(Math.random() * (35000 - 10000 + 1)) + 10000;
            
            setTimeout(() => {
                // Random action chuega
                const actions = ['forward', 'back', 'left', 'right', 'jump'];
                const randomAction = actions[Math.floor(Math.random() * actions.length)];
                
                // Wo action start karega
                bot.setControlState(randomAction, true);
                
                // Randomly idhar-udhar dekhega (camera ghumaiga)
                const randomYaw = (Math.random() * Math.PI) - (Math.PI / 2);
                const randomPitch = (Math.random() * Math.PI) - (Math.PI / 2);
                bot.look(randomYaw, randomPitch);

                // 1.5 second baad chalna/jump karna band kar dega
                setTimeout(() => {
                    bot.setControlState(randomAction, false);
                }, 1500);
                
            }, randomDelay);
        }, 15000); // Ye loop chalta rahega
    }

    // 4. Auto-Reconnect System (Kick ya Leave hone par)
    bot.on('kicked', (reason) => {
        console.log(`Aternos ne kick kiya. Reason: ${reason}`);
    });

    bot.on('end', () => {
        console.log("Bot disconnect ho gaya! 15 second me wapas join kar raha hu... 🔄");
        // Jab bhi bot server se bahar jayega, 15 second baad khud naya bot create karke join karega
        setTimeout(createBot, 15000); 
    });

    bot.on('error', (err) => {
        console.log(`Error aaya: ${err}`);
    });
}

// Pehli baar bot start karne ke liye
createBot();
