import { Telegraf, Markup } from 'telegraf';
import admin from 'firebase-admin';
import fetch from 'node-fetch';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';

// ES modules compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
const firebaseAdmin = admin;


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
  [
    Markup.button.callback('🔔 Send Notification', 'send_notification')
  ],
]);

// Track admin states
const adminStates = new Map();

// Admin Panel: Add Slots to User
bot.action('add_slots', async (ctx) => {
  const userId = ctx.from.id;

  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  // Set admin state to 'add_slots'
  adminStates.set(userId, 'add_slots');
  
  await ctx.reply('Please send the message in format:\nUserID NumberOfSlots\n\nExample: 123456789 5');
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

// Function to send notification to all users or specific user
async function sendNotificationToUsers(message, specificUserId = null) {
  try {
    // If specificUserId is provided, only send to that user
    if (specificUserId) {
      await bot.telegram.sendMessage(specificUserId, message, { 
        parse_mode: 'Markdown',
        disable_notification: false 
      });
      return 1; // Return count of notifications sent
    }
    
    // Otherwise send to all users
    const usersSnapshot = await db.collection('users').get();
    if (usersSnapshot.empty) {
      return 0;
    }

    let sentCount = 0;
    let failedCount = 0;
    
    for (const doc of usersSnapshot.docs) {
      const user = doc.data();
      const chatId = user.chatId;
      
      try {
        await bot.telegram.sendMessage(chatId, message, { 
          parse_mode: 'Markdown',
          disable_notification: false 
        });
        sentCount++;
        
        // Add small delay to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (error) {
        console.error(`Failed to send notification to ${chatId}:`, error);
        failedCount++;
      }
    }
    
    console.log(`Notifications sent: ${sentCount}, Failed: ${failedCount}`);
    return sentCount;
  } catch (error) {
    console.error('Error sending notifications:', error);
    return 0;
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
          
          // Send welcome message to new user
          ctx.reply(
            '🎉 Welcome! You were referred by another user!\n' +
            '📤 You have received your initial storage slots.\n' +
            '💫 Share your own referral link to earn more slots!\n\n' +
            `🔗 Your referral link:\nt.me/${ctx.botInfo.username}?start=${userId}`
          );
          
          // Send enhanced notification to referrer
          const newUserName = ctx.from.first_name || "Someone";
          bot.telegram.sendMessage(startPayload, 
            `🌟 *New Referral Success!*\n\n` +
            `👤 User: ${newUserName}\n` +
            `📊 Your New Total Slots: ${referrerStats.baseLimit + referrerStats.referrals.length}\n` +
            `💰 Reward: +1 Storage Slot\n\n` +
            `Keep sharing your referral link to earn more slots!`,
            { parse_mode: 'Markdown' }
          );

          // Send a celebratory GIF to referrer
          bot.telegram.sendAnimation(startPayload, 
            'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExcHBwNHJ5NjlwNnYyOW53amlxeXp4ZDF2M2E2OGpwZmM0M3d6dTNseiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/3oEduOnl5IHM5NRodO/giphy.gif'
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
const broadcastStates = new Map();

bot.action('broadcast', async (ctx) => {
  const userId = ctx.from.id;

  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  broadcastStates.set(userId, true);
  await ctx.reply('📢 Please send the message you want to broadcast (Text, Image, or Video).');

  // Create message handler for broadcast
  bot.on('message', async (msgCtx) => {
    if (!isAdmin(msgCtx.from.id) || !broadcastStates.get(msgCtx.from.id)) return;
    
    try {
    broadcastStates.delete(msgCtx.from.id); // Reset broadcast state

    const message = msgCtx.message;
    const usersSnapshot = await db.collection('users').get();
    if (usersSnapshot.empty) {
      return msgCtx.reply('⚠️ No users found.');
    }

    let sentCount = 0;
    let failedCount = 0;
    for (const doc of usersSnapshot.docs) {
      const user = doc.data();
      const chatId = user.chatId;

      try {
        if (message.text) {
          await bot.telegram.sendMessage(chatId, message.text);
          sentCount++;
        } else if (message.photo) {
          const photoId = message.photo[message.photo.length - 1].file_id;
          await bot.telegram.sendPhoto(chatId, photoId, {
            caption: message.caption || ''
          });
          sentCount++;
        } else if (message.video) {
          const videoId = message.video.file_id;
          await bot.telegram.sendVideo(chatId, videoId, {
            caption: message.caption || ''
          });
          sentCount++;
        }
        
        // Add small delay to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`Failed to send message to ${chatId}:`, error);
        failedCount++;
      }
    }

    msgCtx.reply(`📊 Broadcast Results:\n✅ Sent to: ${sentCount} users\n❌ Failed: ${failedCount} users`);
  } catch (error) {
    console.error('Broadcast error:', error);
    msgCtx.reply('❌ Error occurred during broadcast. Please try again.');
  }
  });
});

// Admin Panel: Send Notification
bot.action('send_notification', async (ctx) => {
  const userId = ctx.from.id;

  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  // Set admin state
  adminStates.set(userId, 'send_notification');
  
  await ctx.reply('📣 Please send the notification message you want to send to all users.\n\nThis should be a short informational message about updates or system changes.');
});
// Keep these variables for backwards compatibility
let banUserMode = false;
let unbanUserMode = false;
let defaultSlotsMode = false;
let referralRewardMode = false;

// Admin Panel: Ban a User
bot.action('ban_user', async (ctx) => {
  const userId = ctx.from.id;

  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  // Set state in both systems to ensure compatibility
  adminStates.set(userId, 'ban_user');
  banUserMode = true;
  unbanUserMode = false;
  defaultSlotsMode = false;
  referralRewardMode = false;
  
  ctx.reply('Please send the user ID to ban:');
});

// Admin Panel: Unban a User
bot.action('unban_user', async (ctx) => {
  const userId = ctx.from.id;

  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  // Set state in both systems to ensure compatibility
  adminStates.set(userId, 'unban_user');
  banUserMode = false;
  unbanUserMode = true;
  defaultSlotsMode = false;
  referralRewardMode = false;

  ctx.reply('Please send the user ID to unban:');
});

// Improved message handler for admin actions
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  
  // Handle admin states
  if (isAdmin(userId)) {
    // Check if admin is in a specific state
    const adminState = adminStates.get(userId);
    
    if (adminState === 'add_slots') {
      // Process add slots command
      adminStates.delete(userId); // Clear the state
      
      const [targetUserId, slotsToAdd] = text.trim().split(' ');
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
        await ctx.reply(`✅ Successfully added ${slots} slots to user ${targetUserId}.\nNew total slots: ${currentStats.baseLimit + currentStats.referrals.length}`);
        
        // Send notification to the user
        await sendNotificationToUsers(`🔔 *Storage Update*\n\nYour storage slots have been updated! You now have ${currentStats.baseLimit + currentStats.referrals.length} total slots.\n\nUpload more files and enjoy!`, targetUserId);
      } catch (error) {
        console.error('Error adding slots:', error);
        ctx.reply('❌ Error adding slots. Please try again.');
      }
      return;
    }
    
    if (adminState === 'send_notification') {
      // Process notification send
      adminStates.delete(userId); // Clear the state
      
      if (!text || text.length < 5) {
        return ctx.reply('❌ Please provide a valid notification message (at least 5 characters).');
      }
      
      try {
        const notificationMsg = `🔔 *NOTIFICATION*\n\n${text}\n\n_From: Admin_`;
        const sentCount = await sendNotificationToUsers(notificationMsg);
        
        await ctx.reply(`✅ Notification sent successfully to ${sentCount} users.`);
      } catch (error) {
        console.error('Error sending notification:', error);
        ctx.reply('❌ Error sending notification. Please try again.');
      }
      return;
    }
  
    // Handle other admin modes
    if (banUserMode) {
      banUserMode = false;
      bannedUsers.add(text);
      await ctx.reply(`✅ User ${text} has been banned.`);
      return;
    }

    if (unbanUserMode) {
      unbanUserMode = false;
      bannedUsers.delete(text);
      await ctx.reply(`✅ User ${text} has been unbanned.`);
      
      // Send notification to the user about unban
      await sendNotificationToUsers(`🔔 *Account Status Update*\n\nYour account has been unbanned! You can now use all the bot features again.`, text);
      return;
    }

    if (defaultSlotsMode) {
      defaultSlotsMode = false;
      const newLimit = parseInt(text);
      if (isNaN(newLimit) || newLimit < 1) {
        return ctx.reply('❌ Please enter a valid number greater than 0.');
      }

      try {
        const usersSnapshot = await db.collection('users').get();
        for (const doc of usersSnapshot.docs) {
          const userData = doc.data();
          const stats = userData.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
          stats.baseLimit = newLimit;
          await doc.ref.update({ stats });
        }
        await ctx.reply(`✅ Default slot limit updated to ${newLimit} for all users.`);
        
        // Send notification to all users
        await sendNotificationToUsers(`🔔 *Storage Update*\n\nThe default storage slot limit has been updated to ${newLimit} slots! Check your available storage in the my stats menu.`);
      } catch (error) {
        console.error('Error updating slots:', error);
        await ctx.reply('❌ Error updating slots. Please try again.');
      }
      return;
    }

    if (referralRewardMode) {
      referralRewardMode = false;
      const rewardSlots = parseInt(text);
      if (isNaN(rewardSlots) || rewardSlots < 1) {
        return ctx.reply('❌ Please enter a valid number greater than 0.');
      }

      try {
        const usersSnapshot = await db.collection('users').get();
        for (const doc of usersSnapshot.docs) {
          const userData = doc.data();
          const stats = userData.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
          stats.referralReward = rewardSlots;
          await doc.ref.update({ stats });
        }
        await ctx.reply(`✅ Referral reward updated to ${rewardSlots} slots per referral.`);
        
        // Send notification to all users
        await sendNotificationToUsers(`🔔 *Referral Program Update*\n\nGreat news! The referral reward has been updated to ${rewardSlots} slots per referral.\n\nShare your referral link to earn more storage slots!`);
      } catch (error) {
        console.error('Error updating referral reward:', error);
        await ctx.reply('❌ Error updating referral reward. Please try again.');
      }
      return;
    }
  }
});

// Admin Panel: Edit Default Slots
bot.action('edit_default_slots', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  // Clear old modes and set new state
  adminStates.set(ctx.from.id, 'edit_default_slots');
  banUserMode = false;
  unbanUserMode = false;
  defaultSlotsMode = true;
  referralRewardMode = false;

  ctx.reply('Please enter the new default slot limit for new users:');
});

// Admin Panel: Edit Referral Reward
bot.action('edit_referral_reward', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  // Clear old modes and set new state
  adminStates.set(ctx.from.id, 'edit_referral_reward');
  banUserMode = false;
  unbanUserMode = false;
  defaultSlotsMode = false;
  referralRewardMode = true;

  ctx.reply('Please enter the new number of slots to reward per referral:');
});

// Admin command to view banned users
bot.command('viewbanned', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ You are not authorized to view this information.');
  }

  if (bannedUsers.size === 0) {
    return ctx.reply('📢 No users are currently banned.');
  }

  let message = '🚫 Banned Users:\n\n';
  bannedUsers.forEach(userId => {
    message += `• ${userId}\n`;
  });

  ctx.reply(message);
});

// Admin command to clear all bans
bot.command('clearbans', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  const count = bannedUsers.size;
  bannedUsers.clear();
  ctx.reply(`✅ Cleared all bans (${count} users unbanned)`);
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


// Add a simple HTML page for the root route
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Telegram Bot Server</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          margin: 0;
          padding: 20px;
          background-color: #f5f5f5;
        }
        .container {
          max-width: 800px;
          margin: 0 auto;
          background-color: white;
          padding: 20px;
          border-radius: 10px;
          box-shadow: 0 0 10px rgba(0,0,0,0.1);
        }
        h1 {
          color: #0088cc;
          text-align: center;
        }
        .status {
          padding: 15px;
          background-color: #d4edda;
          border-radius: 5px;
          margin: 20px 0;
          text-align: center;
          color: #155724;
        }
        .info {
          line-height: 1.6;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Telegram Bot Status</h1>
        <div class="status">
          ✅ Bot is running
        </div>
        <div class="info">
          <p>Your Telegram bot is active and running. You can interact with it directly in Telegram.</p>
          <p>Server started at: ${new Date().toLocaleString()}</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.listen(5000, '0.0.0.0', () => {
  console.log('✅ Web server running on port 5000');
});

// Start the bot
bot.launch({
  polling: true
});
