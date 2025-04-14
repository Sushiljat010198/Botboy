const { Telegraf, Markup } = require('telegraf');
const firebaseAdmin = require('firebase-admin');
const fetch = require('node-fetch');
const path = require('path');
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;


// Initialize Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS || '{}');
firebaseAdmin.initializeApp({
  credential: firebaseAdmin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});

const storageBucket = firebaseAdmin.storage().bucket();
const db = firebaseAdmin.firestore(); // Firebase Firestore reference
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Function to get user's file count and referral stats
async function getUserStats(userId) {
  const userRef = db.collection('users').doc(String(userId));
  const doc = await userRef.get();
  if (!doc.exists) return { fileCount: 0, referrals: [], baseLimit: 2 };
  return doc.data().stats || { fileCount: 0, referrals: [], baseLimit: 2 };
}

// Function to check if user can upload more files
async function canUploadFile(userId) {
  const stats = await getUserStats(userId);
  const totalAllowedFiles = stats.baseLimit + stats.referrals.length;
  return stats.fileCount < totalAllowedFiles;
}

// Function to update file count
async function updateFileCount(userId, increment = true) {
  const userRef = db.collection('users').doc(String(userId));
  const stats = await getUserStats(userId);
  stats.fileCount = increment ? stats.fileCount + 1 : stats.fileCount - 1;
  await userRef.update({ stats });
}

// Admin ID for validation
const adminId = process.env.ADMIN_ID;

// Set to track banned users
const bannedUsers = new Set();
const users = new Set(); // Track users interacting with the bot

// Helper function to check if user is an admin
const isAdmin = (userId) => {
  return userId === Number(adminId);
};

// Helper function to check if user is banned
const isBanned = (userId) => {
  return bannedUsers.has(userId);
};

// Admin Panel Menu (includes view files, total users, and broadcast)
const adminMenu = Markup.inlineKeyboard([
  [
    Markup.button.callback('📂 View All Files', 'view_files'),
    Markup.button.callback('📊 Total Users', 'total_users')
  ],
  [
    Markup.button.callback('📈 Referral Stats', 'referral_stats'),
    Markup.button.callback('📊 Daily Stats', 'daily_stats')
  ],
  [
    Markup.button.callback('📢 Broadcast', 'broadcast'),
    Markup.button.callback('🎁 Add Slots', 'add_slots')
  ],
  [
    Markup.button.callback('⚙️ Default Slots', 'edit_default_slots'),
    Markup.button.callback('🎯 Referral Reward', 'edit_referral_reward')
  ],
  [
    Markup.button.callback('🚫 Ban User', 'ban_user'),
    Markup.button.callback('🔓 Unban User', 'unban_user')
  ],
]);

// Admin Panel: Add Slots to User
bot.action('add_slots', async (ctx) => {
  const userId = ctx.from.id;

  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  ctx.reply('Please send the message in format:\nUserID NumberOfSlots\n\nExample: 123456789 5');

  bot.on('text', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;

    const [targetUserId, slotsToAdd] = ctx.message.text.trim().split(' ');
    const slots = parseInt(slotsToAdd);

    if (!targetUserId || isNaN(slots)) {
      return ctx.reply('❌ Invalid format. Please use: UserID NumberOfSlots');
    }

    try {
      const userRef = db.collection('users').doc(String(targetUserId));
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        return ctx.reply('❌ User not found.');
      }

      const userData = userDoc.data();
      const currentStats = userData.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
      currentStats.baseLimit += slots;

      await userRef.update({ stats: currentStats });
      ctx.reply(`✅ Successfully added ${slots} slots to user ${targetUserId}.\nNew total slots: ${currentStats.baseLimit + currentStats.referrals.length}`);
    } catch (error) {
      console.error('Error adding slots:', error);
      ctx.reply('❌ Error adding slots. Please try again.');
    }
  });
});

// Admin Panel: View Referral Stats
bot.action('referral_stats', async (ctx) => {
  const userId = ctx.from.id;

  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  const usersSnapshot = await db.collection('users').get();
  if (usersSnapshot.empty) {
    return ctx.reply('⚠️ No users found.');
  }

  let totalReferrals = 0;
  let topReferrers = [];

  usersSnapshot.forEach(doc => {
    const user = doc.data();
    const stats = user.stats || { referrals: [] };
    const referralCount = stats.referrals.length;
    totalReferrals += referralCount;

    if (referralCount > 0) {
      topReferrers.push({
        name: user.name || 'Unknown',
        chatId: user.chatId,
        referrals: referralCount
      });
    }
  });

  // Sort top referrers by referral count
  topReferrers.sort((a, b) => b.referrals - a.referrals);

  let message = `📊 Referral System Statistics\n\n`;
  message += `Total Referrals: ${totalReferrals}\n\n`;
  message += `Top Referrers:\n`;

  topReferrers.slice(0, 10).forEach((user, index) => {
    message += `${index + 1}. ${user.name} (ID: ${user.chatId}) - ${user.referrals} referrals\n`;
  });

  ctx.reply(message);
});

// User Panel Menu (only upload file option)
const userMenu = Markup.inlineKeyboard([
  [
    Markup.button.callback('📤 Upload File', 'upload'),
    Markup.button.callback('📂 My Files', 'myfiles')
  ],
  [
    Markup.button.callback('❌ Delete File', 'delete'),
    Markup.button.callback('⭐ My Stats', 'mystats')
  ],
  [
    Markup.button.callback('🎁 Refer & Earn', 'refer'),
    Markup.button.callback('🎯 Daily Tasks', 'tasks')
  ],
  [
    Markup.button.callback('❓ Help Guide', 'guide'),
    Markup.button.callback('📞 Contact Admin', 'contact')
  ]
]);

// Handle new menu actions
bot.action('mystats', async (ctx) => {
  const stats = await getUserStats(ctx.from.id);
  const totalSlots = stats.baseLimit + stats.referrals.length;
  
  ctx.reply(
    `📊 *Your Account Statistics*\n\n` +
    `📁 Files Uploaded: ${stats.fileCount}\n` +
    `💾 Total Storage Slots: ${totalSlots}\n` +
    `👥 Referrals Made: ${stats.referrals.length}\n` +
    `🌟 Account Level: ${Math.floor(stats.referrals.length/2) + 1}\n\n` +
    `Progress to next level:\n` +
    `[${'▰'.repeat(stats.referrals.length % 2)}${'▱'.repeat(2 - (stats.referrals.length % 2))}]`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('tasks', async (ctx) => {
  const stats = await getUserStats(ctx.from.id);
  ctx.reply(
    `🎯 *Daily Tasks*\n\n` +
    `1. 📤 Upload a file (${stats.fileCount > 0 ? '✅' : '❌'})\n` +
    `2. 🔗 Share your referral link (${stats.referrals.length > 0 ? '✅' : '❌'})\n` +
    `3. 👥 Invite a friend (${stats.referrals.length > 0 ? '✅' : '❌'})\n\n` +
    `Complete tasks to earn more storage slots!`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('guide', (ctx) => {
  ctx.reply(
    `📚 *Bot Usage Guide*\n\n` +
    `1. 📤 *Upload Files*\n` +
    `   - Send HTML/ZIP files\n` +
    `   - Get instant hosting links\n\n` +
    `2. 🎁 *Earn More Storage*\n` +
    `   - Share your referral link\n` +
    `   - Each referral = +1 slot\n\n` +
    `3. 📂 *Manage Files*\n` +
    `   - View all your uploads\n` +
    `   - Delete unwanted files\n\n` +
    `4. 📊 *Track Progress*\n` +
    `   - Check your stats\n` +
    `   - Complete daily tasks`,
    { parse_mode: 'Markdown' }
  );
});

// Handle refer button click
bot.action('refer', async (ctx) => {
  const userId = ctx.from.id;
  const stats = await getUserStats(userId);
  const totalSlots = stats.baseLimit + stats.referrals.length;
  const usedSlots = Math.max(0, Math.min(stats.fileCount, totalSlots));
  const remainingSlots = Math.max(0, totalSlots - usedSlots);
  const referralCount = Math.min(stats.referrals.length, 5);
  const remainingReferrals = Math.max(0, 5 - referralCount);
  
  ctx.reply(
    `🌟 *Your Referral Dashboard*\n\n` +
    `📊 *Storage Status:*\n` +
    `[${usedSlots}/${totalSlots}] ${'▰'.repeat(usedSlots)}${'▱'.repeat(remainingSlots)}\n\n` +
    `👥 *Referral Progress:*\n` +
    `Total Referrals: ${stats.referrals.length}\n` +
    `${'🟢'.repeat(referralCount)}${'⚪️'.repeat(remainingReferrals)}\n\n` +
    `🎁 *Share your link to earn more:*\n` +
    `https://t.me/${ctx.botInfo.username}?start=${userId}\n\n` +
    `💫 *Rewards:*\n` +
    `• Each referral = ${stats.referralReward || 1} upload slots!\n` +
    `• Maximum referrals = Unlimited\n` +
    `• Your current reward: ${stats.referrals.length * (stats.referralReward || 1)} slots`,
    { parse_mode: 'Markdown' }
  );

// Send referral GIF
ctx.replyWithAnimation('https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExcHBwNHJ5NjlwNnYyOW53amlxeXp4ZDF2M2E2OGpwZmM0M3d6dTNseiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/3oEduOnl5IHM5NRodO/giphy.gif');
});

// Function to track daily usage
async function trackDailyUsage(userId) {
  const today = new Date().toISOString().split('T')[0];
  const statsRef = db.collection('dailyStats').doc(today);
  
  try {
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(statsRef);
      if (!doc.exists) {
        transaction.set(statsRef, { users: [userId], count: 1 });
      } else {
        const data = doc.data();
        if (!data.users.includes(userId)) {
          transaction.update(statsRef, {
            users: [...data.users, userId],
            count: data.count + 1
          });
        }
      }
    });
  } catch (error) {
    console.error('Error tracking daily usage:', error);
  }
}

// Handler for daily stats button
bot.action('daily_stats', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to view this information.');
  }

  const today = new Date().toISOString().split('T')[0];
  const statsRef = db.collection('dailyStats').doc(today);
  const doc = await statsRef.get();

  if (!doc.exists) {
    return ctx.reply('📊 No users today yet.');
  }

  const data = doc.data();
  ctx.reply(`📊 Daily Statistics\n\nToday (${today}):\n👥 Total Users: ${data.count}`);
});

// Start command
bot.start(async (ctx) => {
  await trackDailyUsage(ctx.from.id);
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || "Unknown";
  const startPayload = ctx.startPayload; // Get referral code if any

  if (isBanned(userId)) {
    return ctx.reply('❌ You are banned from using this bot.');
  }

  users.add(userId);

  const userRef = db.collection('users').doc(String(userId));
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    const initialData = {
      chatId: userId,
      name: userName,
      joinedAt: new Date().toISOString(),
      stats: { fileCount: 0, referrals: [], baseLimit: 2 }
    };

    // Handle referral
    if (startPayload && startPayload !== String(userId)) {
      const referrerRef = db.collection('users').doc(startPayload);
      const referrerDoc = await referrerRef.get();
      
      if (referrerDoc.exists) {
        const referrerStats = await getUserStats(startPayload);
        if (!referrerStats.referrals.includes(String(userId))) {
          referrerStats.referrals.push(String(userId));
          await referrerRef.update({ stats: referrerStats });
          ctx.reply('✅ You were referred! Your referrer got an extra file slot.');
          
          // Send notification to referrer about new slot
          bot.telegram.sendMessage(startPayload, 
            '🎉 Congratulations! Someone used your referral link!\n' +
            '📤 You can now upload one more file!\n' +
            '📊 New total slots: ' + (referrerStats.baseLimit + referrerStats.referrals.length)
          );
        }
      }
    }

    await userRef.set(initialData);
  }

  if (isAdmin(userId)) {
    ctx.reply('Welcome to the Admin Panel! Use the menu below:', adminMenu);
  } else {
    ctx.reply(
  '🚀 *Welcome to the HTML Hosting Bot!*\n\n' +
  '🌟 *Features:*\n' +
  '• Upload HTML/ZIP files\n' +
  '• Get instant file links\n' +
  '• Manage your uploads\n' +
  '• Earn more slots through referrals\n\n' +
  '🎯 Select an option below:', 
  { 
    parse_mode: 'Markdown',
    ...userMenu
  }
);
  }
});

// Admin Panel: View All Files
bot.action('view_files', async (ctx) => {
  const userId = ctx.from.id;

  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  const files = await storageBucket.getFiles({ prefix: 'uploads/' });
  if (files[0].length === 0) {
    return ctx.reply('📂 No uploaded files found.');
  }

  let message = '📜 All uploaded files:\n';
  files[0].forEach((file) => {
    message += `🔗 [${file.name}](https://firebasestorage.googleapis.com/v0/b/${storageBucket.name}/o/${encodeURIComponent(file.name)}?alt=media)\n`;
  });

  ctx.reply(message, { parse_mode: 'Markdown' });
});

// Admin command: Show all users and their details
bot.command('viewusers', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ You are not authorized to view this information.');
  }

  // Fetch all users from Firestore (assuming users are stored in a collection 'users')
  const usersSnapshot = await db.collection('users').get();
  
  if (usersSnapshot.empty) {
    return ctx.reply('⚠️ No users found.');
  }

  let userList = `📜 Total Users: ${usersSnapshot.size}\n\n`;

  // Loop through all users and display their details
  usersSnapshot.forEach((doc) => {
    const user = doc.data();
    userList += `👤 Name: ${user.name || 'Unknown'}\n`;
    userList += `💬 Chat ID: ${user.chatId}\n\n`;
  });

  ctx.reply(userList);
});

// Admin Panel: Total Users
bot.action('total_users', async (ctx) => {
  const userId = ctx.from.id;

  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  const usersSnapshot = await db.collection('users').get();
  if (usersSnapshot.empty) {
    return ctx.reply('⚠️ No registered users found.');
  }

  let userList = `📊 Total Users: ${usersSnapshot.size}\n\n`;
  let count = 0;
  
  for (const doc of usersSnapshot.docs) {
    const user = doc.data();
    count++;
    userList += `${count}. 👤 ${user.name || 'Unknown'} (ID: ${user.chatId})\n`;
    
    // Send message in chunks to avoid telegram message length limit
    if (count % 50 === 0) {
      await ctx.reply(userList);
      userList = '';
    }
  }
  
  if (userList) {
    await ctx.reply(userList);
  }
});

// Track broadcast state
let broadcastMode = false;
let messageHandler = null;

bot.action('broadcast', async (ctx) => {
  const userId = ctx.from.id;

  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  broadcastMode = true;
  ctx.reply('📢 Please send the message you want to broadcast (Text, Image, or Video).');

  // Remove existing handler if any
  if (messageHandler) {
    bot.off('message', messageHandler);
  }

  // Create new message handler
  messageHandler = async (ctx) => {
    if (!isAdmin(ctx.from.id) || !broadcastMode) return;

    const message = ctx.message;
    const usersSnapshot = await db.collection('users').get();
    if (usersSnapshot.empty) {
      broadcastMode = false;
      bot.off('message', messageHandler);
      return ctx.reply('⚠️ No users found.');
    }

    let sentCount = 0;
    for (const doc of usersSnapshot.docs) {
      const user = doc.data();
      const chatId = user.chatId;

      try {
        if (message.text) {
          await bot.telegram.sendMessage(chatId, message.text);
        } else if (message.photo) {
          const photoId = message.photo[message.photo.length - 1].file_id;
          await bot.telegram.sendPhoto(chatId, photoId, { caption: message.caption || '' });
        } else if (message.video) {
          const videoId = message.video.file_id;
          await bot.telegram.sendVideo(chatId, videoId, { caption: message.caption || '' });
        }

        sentCount++;
      } catch (error) {
        console.error(`Failed to send message to ${chatId}:`, error);
      }
    }

    ctx.reply(`✅ Broadcast sent to ${sentCount} users.`);
    
    // Clean up after broadcast
    broadcastMode = false;
    bot.off('message', messageHandler);
  };

  // Register the new handler
  bot.on('message', messageHandler);
});
// Admin Panel: Ban a User
bot.action('ban_user', async (ctx) => {
  const userId = ctx.from.id;

  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  ctx.reply('Please send the user ID to ban:');
  bot.on('text', (ctx) => {
    const targetUserId = ctx.message.text.trim();
    if (targetUserId) {
      bannedUsers.add(targetUserId);
      ctx.reply(`✅ User ${targetUserId} has been banned.`);
    }
  });
});

// Admin Panel: Unban a User
bot.action('unban_user', async (ctx) => {
  const userId = ctx.from.id;

  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  ctx.reply('Please send the user ID to unban:');
  bot.on('text', (ctx) => {
    const targetUserId = ctx.message.text.trim();
    if (targetUserId) {
      bannedUsers.delete(targetUserId);
      ctx.reply(`✅ User ${targetUserId} has been unbanned.`);
    }
  });
});

// Admin Panel: Edit Default Slots
bot.action('edit_default_slots', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  ctx.reply('Please enter the new default slot limit for new users:');
  
  bot.on('text', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    
    const newLimit = parseInt(ctx.message.text);
    if (isNaN(newLimit) || newLimit < 1) {
      return ctx.reply('❌ Please enter a valid number greater than 0.');
    }

    // Update all users' base limit
    const usersSnapshot = await db.collection('users').get();
    for (const doc of usersSnapshot.docs) {
      const userData = doc.data();
      const stats = userData.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
      stats.baseLimit = newLimit;
      await doc.ref.update({ stats });
    }

    ctx.reply(`✅ Default slot limit updated to ${newLimit} for all users.`);
  });
});

// Admin Panel: Edit Referral Reward
bot.action('edit_referral_reward', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  ctx.reply('Please enter the new number of slots to reward per referral:');
  
  bot.on('text', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    
    const rewardSlots = parseInt(ctx.message.text);
    if (isNaN(rewardSlots) || rewardSlots < 1) {
      return ctx.reply('❌ Please enter a valid number greater than 0.');
    }

    // Update all users with referrals
    const usersSnapshot = await db.collection('users').get();
    for (const doc of usersSnapshot.docs) {
      const userData = doc.data();
      const stats = userData.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
      const totalReferralSlots = stats.referrals.length * rewardSlots;
      stats.referralReward = rewardSlots;
      await doc.ref.update({ stats });
    }

    ctx.reply(`✅ Referral reward updated to ${rewardSlots} slots per referral.`);
  });
});

// Admin Panel: Help Command (List Admin Commands)
bot.command('help', (ctx) => {
  const userId = ctx.from.id;

  if (isAdmin(userId)) {
    ctx.reply(
      `⚙️ **Admin Commands:**
      /listfiles - List all uploaded files
      /viewusers - View all users who have interacted with the bot
      /deleteuserfiles <user_id> - Delete a user's uploaded files
      /banuser <user_id> - Ban a user
      /unbanuser <user_id> - Unban a user
      /status - View bot status
      `
    );
  } else {
    ctx.reply(
      `⚙️ **User Commands:**
      /upload - Upload a file
      /myfiles - View your uploaded files`
    );
  }
});

// User Panel: Upload File
bot.action('upload', (ctx) => {
  ctx.reply('Please send me an HTML or ZIP file to host.');
});

bot.action('contact', (ctx) => {
  ctx.reply(
    '📌 message me  for any query = @Gamaspyowner:\n\n' +
    '🔗 [🚀Message me](https://t.me/Gamaspyowner)',
    { parse_mode: 'Markdown' }
  );
});

// Handle file uploads
bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  
  if (isBanned(userId)) {
    return ctx.reply('❌ You are banned from using this bot.');
  }

  const canUpload = await canUploadFile(userId);
  if (!canUpload) {
    const stats = await getUserStats(userId);
    const totalSlots = stats.baseLimit + stats.referrals.length;
    return ctx.reply(`❌ You've reached your file upload limit (${stats.fileCount}/${totalSlots})\n\nShare your referral link to get more slots:\nt.me/${ctx.botInfo.username}?start=${userId}`);
  }

  const file = ctx.message.document;
  if (!file.file_name.endsWith('.html') && !file.file_name.endsWith('.zip')) {
    return ctx.reply('⚠️ Please upload an HTML or ZIP file.');
  }
  
  const progressMsg = await ctx.reply(
    '📤 *Processing Your File*\n\n' +
    '⬆️ Progress Bar:\n' +
    '▰▰▰▰▰▰▰▰▰▰ 100%\n\n' +
    '✨ _Almost done..._',
    { parse_mode: 'Markdown' }
  );

  try {
    const fileRef = storageBucket.file(`uploads/${ctx.from.id}/${file.file_name}`);
    const fileBuffer = await bot.telegram.getFileLink(file.file_id);
    const fileStream = await fetch(fileBuffer).then(res => res.buffer());

    // Set proper content type for HTML files
    const contentType = file.file_name.endsWith('.html') ? 'text/html; charset=utf-8' : file.mime_type;
    
    await fileRef.save(fileStream, {
      contentType: contentType,
      metadata: { 
        firebaseStorageDownloadTokens: 'token',
        contentType: contentType,
        cacheControl: 'no-cache'
      },
      public: true,
      validation: 'md5'
    });

    const fileLink = `https://firebasestorage.googleapis.com/v0/b/${storageBucket.name}/o/${encodeURIComponent(fileRef.name)}?alt=media&token=token`;
    await updateFileCount(ctx.from.id, true);
    const stats = await getUserStats(ctx.from.id);
    const totalSlots = stats.baseLimit + stats.referrals.length;
    ctx.reply(
  `🎉 *Success! File Uploaded!*\n\n` +
  `📂 File Link:\n${fileLink}\n\n` +
  `📊 Storage Usage:\n[${stats.fileCount}/${totalSlots}] ${'▰'.repeat(stats.fileCount) + '▱'.repeat(totalSlots - stats.fileCount)}\n\n` +
  `🎁 *Want More Storage?*\n` +
  `Share your referral link:\n` +
  `t.me/${ctx.botInfo.username}?start=${ctx.from.id}\n\n` +
  `💡 _For best results, open in Chrome browser_`,
  { parse_mode: 'Markdown' }
);

// Send a celebratory GIF
ctx.replyWithAnimation('https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExcDN1Z2E3OGhpbXE3M3Q2NmFwbzF6Y2ptdWxqdWx0NXh0aHR4anV3eiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/xT0xezQGU5xCDJuCPe/giphy.gif');
  } catch (error) {
    ctx.reply('❌ Error uploading your file. Try again later.');
    console.error(error);
  }
});

// View My Files
bot.action('myfiles', async (ctx) => {
  if (isBanned(ctx.from.id)) {
    return ctx.reply('❌ You are banned from using this bot.');
  }

  try {
    const [files] = await storageBucket.getFiles({ prefix: `uploads/${ctx.from.id}/` });
    if (files.length === 0) {
      return ctx.reply('📂 You have no uploaded files.');
    }

    let message = '📄 Your uploaded files:\n';
    for (const file of files) {
      message += `🔗 [${file.name}](https://firebasestorage.googleapis.com/v0/b/${storageBucket.name}/o/${encodeURIComponent(file.name)}?alt=media)\n`;
    }

    ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply('❌ Error fetching your files.');
    console.error(error);
  }
});


// Delete a file
// Delete a file
bot.action('delete', async (ctx) => {
  const userId = ctx.from.id;

  if (isBanned(userId)) {
    return ctx.reply('❌ You are banned from using this bot.');
  }

  try {
    const [files] = await storageBucket.getFiles({ prefix: `uploads/${userId}/` });
    if (files.length === 0) {
      return ctx.reply('📂 You have no files to delete.');
    }

    const fileButtons = files.map(file => {
      const fileName = file.name.split('/').pop();
      return [Markup.button.callback(`🗑️ ${fileName}`, `del_${fileName}`)];
    });

    ctx.reply('Select a file to delete:', Markup.inlineKeyboard(fileButtons));
  } catch (error) {
    ctx.reply('❌ Error fetching your files.');
    console.error(error);
  }
});

// Handle file deletion button clicks
bot.action(/^del_(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const fileName = ctx.match[1];

  try {
    const fileRef = storageBucket.file(`uploads/${userId}/${fileName}`);
    const [exists] = await fileRef.exists();
    
    if (!exists) {
      return ctx.reply(`❌ File ${fileName} not found.`);
    }

    await fileRef.delete();
    await updateFileCount(ctx.from.id, false);
    await ctx.reply(`✅ File ${fileName} deleted successfully.`);
  } catch (error) {
    ctx.reply(`❌ Error deleting file ${fileName}.`);
    console.error(error);
  }
});


app.listen(5000, '0.0.0.0', () => {
  console.log('✅ Web server running on port 5000');
});

// Start the bot
bot.launch({
  polling: true
});
