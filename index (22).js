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
    Markup.button.callback('🔔 Send Notification', 'send_notification'),
    Markup.button.callback('👑 Premium Users', 'premium_users')
  ],
  [
    Markup.button.callback('🗑️ Delete User Files', 'delete_user_files'),
    Markup.button.callback('📝 View User Files', 'view_user_files')
  ],
  [
    Markup.button.callback('⚙️ Bot Settings', 'bot_settings')
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

// User Panel Menu with enhanced options
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
    Markup.button.callback('👑 Get Premium', 'get_premium')
  ],
  [
    Markup.button.callback('🛠️ Advanced Options', 'advanced_options'),
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
    // Check notification settings
    if (!specificUserId) {
      const configRef = db.collection('botConfig').doc('notifications');
      const configDoc = await configRef.get();
      
      if (configDoc.exists && configDoc.data().enabled === false) {
        console.log('Notifications are currently disabled by admin.');
        return 0;
      }
    }
    
    // If specificUserId is provided, only send to that user
    if (specificUserId) {
      try {
        await bot.telegram.sendMessage(specificUserId, message, { 
          parse_mode: 'Markdown',
          disable_notification: false 
        });
        return 1; // Return count of notifications sent
      } catch (error) {
        console.log(`Could not send notification to user ${specificUserId}: ${error.message}`);
        return 0;
      }
    }
    
    // Otherwise send to all users
    const usersSnapshot = await db.collection('users').get();
    if (usersSnapshot.empty) {
      return 0;
    }

    let sentCount = 0;
    let failedCount = 0;
    let activeUsers = []; // Track active users
    
    for (const doc of usersSnapshot.docs) {
      const user = doc.data();
      const chatId = user.chatId;
      
      if (!chatId) continue; // Skip if no chatId
      if (user.notifications === false) continue; // Skip if user has disabled notifications
      
      try {
        await bot.telegram.sendMessage(chatId, message, { 
          parse_mode: 'Markdown',
          disable_notification: false 
        });
        sentCount++;
        activeUsers.push(chatId); // Add to active users list
        
        // Add small delay to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (error) {
        // Skip logging for "chat not found" errors
        if (error.message.includes('chat not found')) {
          // User has blocked the bot or deleted the chat
          failedCount++;
        } else {
          console.error(`Failed to send notification to ${chatId}:`, error);
          failedCount++;
        }
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

// Admin Panel: Premium Users
bot.action('premium_users', async (ctx) => {
  const userId = ctx.from.id;

  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  // Create premium management menu
  const premiumMenu = Markup.inlineKeyboard([
    [
      Markup.button.callback('👑 Add Premium User', 'add_premium_user'),
      Markup.button.callback('❌ Remove Premium', 'remove_premium_user')
    ],
    [
      Markup.button.callback('📋 List Premium Users', 'list_premium_users'),
      Markup.button.callback('⚙️ Premium Settings', 'premium_settings')
    ],
    [
      Markup.button.callback('◀️ Back to Admin Menu', 'back_to_admin')
    ]
  ]);

  await ctx.reply('👑 *Premium User Management*\n\nManage premium users and their special privileges.', {
    parse_mode: 'Markdown',
    ...premiumMenu
  });
});

// Handler for adding premium user
bot.action('add_premium_user', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  adminStates.set(userId, 'add_premium_user');
  await ctx.reply('Please enter the user ID to make premium:');
});

// Handler for removing premium user
bot.action('remove_premium_user', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  adminStates.set(userId, 'remove_premium_user');
  await ctx.reply('Please enter the user ID to remove premium status:');
});

// Handler for listing premium users
bot.action('list_premium_users', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  try {
    const premiumUsersSnapshot = await db.collection('users')
      .where('premium', '==', true)
      .get();
    
    if (premiumUsersSnapshot.empty) {
      return ctx.reply('📝 No premium users found.');
    }
    
    let message = '👑 *Premium Users*\n\n';
    premiumUsersSnapshot.forEach(doc => {
      const user = doc.data();
      message += `👤 ${user.name || 'Unknown'} (ID: ${user.chatId})\n`;
      message += `📅 Premium since: ${user.premiumSince || 'Unknown'}\n\n`;
    });
    
    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error listing premium users:', error);
    await ctx.reply('❌ Error retrieving premium users.');
  }
});

// Handler for premium settings
bot.action('premium_settings', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  // Create premium settings menu
  const premiumSettingsMenu = Markup.inlineKeyboard([
    [
      Markup.button.callback('⚙️ Default Premium Slots', 'premium_default_slots'),
      Markup.button.callback('📊 Premium Features', 'premium_features')
    ],
    [
      Markup.button.callback('⏱️ Premium Duration', 'premium_duration'),
      Markup.button.callback('🎁 Premium Welcome Msg', 'premium_welcome_msg')
    ],
    [
      Markup.button.callback('◀️ Back to Premium Menu', 'premium_users')
    ]
  ]);
  
  await ctx.reply('⚙️ *Premium Settings*\n\nConfigure premium user benefits and features.', {
    parse_mode: 'Markdown',
    ...premiumSettingsMenu
  });
});

// Premium default slots setting
bot.action('premium_default_slots', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  adminStates.set(userId, 'premium_default_slots');
  await ctx.reply('Please enter the default number of slots for premium users:');
});

// Premium features configuration
bot.action('premium_features', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  // Fetch current premium features
  const configRef = db.collection('botConfig').doc('premiumFeatures');
  const configDoc = await configRef.get();
  
  let features = {};
  if (configDoc.exists) {
    features = configDoc.data();
  }
  
  // Display current premium features
  const enabledFeatures = Object.entries(features)
    .filter(([_, enabled]) => enabled)
    .map(([feature]) => `✅ ${feature}`)
    .join('\n');
  
  const disabledFeatures = Object.entries(features)
    .filter(([_, enabled]) => !enabled)
    .map(([feature]) => `❌ ${feature}`)
    .join('\n');
  
  const featureMenu = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Enable Priority Support', 'enable_priority_support'),
      Markup.button.callback('❌ Disable Priority Support', 'disable_priority_support')
    ],
    [
      Markup.button.callback('✅ Enable More File Types', 'enable_more_file_types'),
      Markup.button.callback('❌ Disable More File Types', 'disable_more_file_types')
    ],
    [
      Markup.button.callback('✅ Enable No Daily Limit', 'enable_no_daily_limit'),
      Markup.button.callback('❌ Disable No Daily Limit', 'disable_no_daily_limit')
    ],
    [
      Markup.button.callback('◀️ Back to Premium Settings', 'premium_settings')
    ]
  ]);
  
  let message = '🎭 *Premium Features*\n\n';
  message += enabledFeatures ? `*Enabled Features:*\n${enabledFeatures}\n\n` : '';
  message += disabledFeatures ? `*Disabled Features:*\n${disabledFeatures}\n\n` : '';
  message += `Select features to enable or disable:`;
  
  await ctx.reply(message, {
    parse_mode: 'Markdown',
    ...featureMenu
  });
});

// Premium duration setting
bot.action('premium_duration', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  adminStates.set(userId, 'premium_duration');
  await ctx.reply('Please enter the default premium subscription duration in days:');
});

// Premium welcome message
bot.action('premium_welcome_msg', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  adminStates.set(userId, 'premium_welcome_msg');
  await ctx.reply('Please enter the welcome message for new premium users. You can use Markdown formatting:');
});

// Premium feature toggling
bot.action(/^(enable|disable)_(priority_support|more_file_types|no_daily_limit)$/, async (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  const action = ctx.match[1]; // 'enable' or 'disable'
  const feature = ctx.match[2]; // 'priority_support', 'more_file_types', or 'no_daily_limit'
  const enabled = action === 'enable';
  
  try {
    // Get current premium features
    const configRef = db.collection('botConfig').doc('premiumFeatures');
    const configDoc = await configRef.get();
    
    let features = {};
    if (configDoc.exists) {
      features = configDoc.data();
    }
    
    // Update feature
    features[feature] = enabled;
    
    // Save to database
    await configRef.set({
      ...features,
      updatedAt: new Date().toISOString(),
      updatedBy: userId
    });
    
    await ctx.reply(`✅ ${feature.replace(/_/g, ' ').toUpperCase()} has been ${enabled ? 'enabled' : 'disabled'} for premium users.`);
    
    // Return to premium features menu
    setTimeout(() => {
      ctx.telegram.sendMessage(userId, '⚙️ Back to Premium Features:', {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Enable Priority Support', callback_data: 'enable_priority_support' },
              { text: '❌ Disable Priority Support', callback_data: 'disable_priority_support' }
            ],
            [
              { text: '✅ Enable More File Types', callback_data: 'enable_more_file_types' },
              { text: '❌ Disable More File Types', callback_data: 'disable_more_file_types' }
            ],
            [
              { text: '✅ Enable No Daily Limit', callback_data: 'enable_no_daily_limit' },
              { text: '❌ Disable No Daily Limit', callback_data: 'disable_no_daily_limit' }
            ],
            [
              { text: '◀️ Back to Premium Settings', callback_data: 'premium_settings' }
            ]
          ]
        }
      });
    }, 1000);
  } catch (error) {
    console.error('Error toggling premium feature:', error);
    ctx.reply('❌ Error updating premium feature settings. Please try again.');
  }
});

// Handler for going back to admin menu
bot.action('back_to_admin', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  await ctx.reply('Back to Admin Panel:', adminMenu);
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
    
    if (adminState === 'report_bug') {
      // Process bug report from user
      adminStates.delete(userId);
      
      try {
        const userName = ctx.from.first_name || "Unknown";
        
        // Format the bug report message for admins
        const bugReportMessage = 
          `🐛 *Bug Report Received*\n\n` +
          `From: ${userName} (ID: ${userId})\n\n` +
          `*Report:*\n${text}\n\n` +
          `Submitted: ${new Date().toISOString()}`;
        
        // Notify all admins about the bug report
        const adminIds = process.env.ADMIN_ID.split(',').map(id => id.trim());
        
        let sentToAdmins = 0;
        for (const adminId of adminIds) {
          try {
            await bot.telegram.sendMessage(adminId, bugReportMessage, {
              parse_mode: 'Markdown'
            });
            sentToAdmins++;
          } catch (error) {
            console.error(`Failed to send bug report to admin ${adminId}:`, error);
          }
        }
        
        // Reply to the user
        await ctx.reply(
          '✅ *Bug Report Submitted*\n\n' +
          'Thank you for your report! Our team has been notified and will investigate the issue.\n\n' +
          'We appreciate your help in improving our service!',
          { parse_mode: 'Markdown' }
        );
        
        console.log(`Bug report from user ${userId} sent to ${sentToAdmins} admins`);
      } catch (error) {
        console.error('Error processing bug report:', error);
        await ctx.reply('❌ Error submitting bug report. Please try again later or contact admin directly.');
      }
      return;
    }
    
    if (adminState === 'message_user') {
      // Process direct message to user from admin
      adminStates.delete(userId);
      
      // Get the target user ID from the state
      const targetUserId = adminStates.get(userId + '_target');
      adminStates.delete(userId + '_target');
      
      if (!targetUserId) {
        return ctx.reply('❌ Error: No target user specified. Message not sent.');
      }
      
      try {
        // Send the message to the target user
        await sendNotificationToUsers(
          `📨 *Message from Admin*\n\n${text}\n\n` +
          'To reply, please use the "Contact Admin" button in the main menu.',
          targetUserId
        );
        
        await ctx.reply(`✅ Message sent successfully to user ${targetUserId}.`);
      } catch (error) {
        console.error('Error sending direct message to user:', error);
        await ctx.reply('❌ Error sending message. Please try again.');
      }
      return;
    }
    
    if (adminState === 'add_premium_user_prefilled') {
      // Process adding premium user with prefilled ID
      adminStates.delete(userId);
      
      // Get the target user ID from the state
      const targetUserId = adminStates.get(userId + '_target');
      adminStates.delete(userId + '_target');
      
      if (!targetUserId) {
        return ctx.reply('❌ Error: No target user specified. Premium not added.');
      }
      
      // Get premium slots from input or use default
      let premiumSlots;
      if (text && text.trim() !== '') {
        premiumSlots = parseInt(text.trim());
        if (isNaN(premiumSlots) || premiumSlots < 1) {
          // Get premium configuration for default slots
          const configRef = db.collection('botConfig').doc('premiumSettings');
          const configDoc = await configRef.get();
          
          if (configDoc.exists && configDoc.data().defaultSlots) {
            premiumSlots = configDoc.data().defaultSlots;
          } else {
            premiumSlots = 10; // Fallback default
          }
        }
      } else {
        // Get premium configuration for default slots
        const configRef = db.collection('botConfig').doc('premiumSettings');
        const configDoc = await configRef.get();
        
        if (configDoc.exists && configDoc.data().defaultSlots) {
          premiumSlots = configDoc.data().defaultSlots;
        } else {
          premiumSlots = 10; // Fallback default
        }
      }
      
      try {
        // Get premium configuration (duration, etc.)
        const configRef = db.collection('botConfig').doc('premiumSettings');
        const configDoc = await configRef.get();
        
        let durationInDays = 30; // Default duration
        if (configDoc.exists && configDoc.data().durationInDays) {
          durationInDays = configDoc.data().durationInDays;
        }
        
        // Calculate expiration date
        const now = new Date();
        const premiumUntil = new Date(now.getTime() + (durationInDays * 24 * 60 * 60 * 1000));
        
        // Update user to premium
        const userRef = db.collection('users').doc(String(targetUserId));
        const userDoc = await userRef.get();
        
        if (!userDoc.exists) {
          return ctx.reply('❌ User not found.');
        }
        
        await userRef.update({ 
          premium: true,
          premiumUntil: premiumUntil.toISOString(),
          premiumApprovedBy: userId,
          premiumApprovedAt: now.toISOString()
        });
        
        // Update user slots
        const userData = userDoc.data();
        const currentStats = userData.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
        currentStats.baseLimit = premiumSlots;
        await userRef.update({ stats: currentStats });
        
        await ctx.reply(`✅ User ${targetUserId} is now a premium user with ${premiumSlots} slots until ${premiumUntil.toDateString()}!`);
        
        // Create custom welcome message
        let welcomeMessage = `🌟 *Premium Upgrade*\n\n` +
          `Congratulations! Your premium request has been approved!\n\n` +
          `✨ Benefits:\n` +
          `• ${currentStats.baseLimit} storage slots\n` +
          `• Priority support\n` +
          `• More file formats support\n` +
          `• Faster upload speeds\n\n` +
          `Your premium access expires on: ${premiumUntil.toDateString()}\n\n` +
          `Thank you for your support!`;
          
        // Check if premium welcome message exists in the settings we loaded
        if (configDoc.exists && configDoc.data().welcomeMessage) {
          // Use custom welcome message if exists, with {slots} placeholder replaced
          welcomeMessage = configDoc.data().welcomeMessage.replace('{slots}', currentStats.baseLimit);
        }
        
        // Send notification to the user
        await sendNotificationToUsers(welcomeMessage, targetUserId);
      } catch (error) {
        console.error('Error approving premium user:', error);
        ctx.reply('❌ Error upgrading user. Please try again.');
      }
      return;
    }
    
    if (adminState === 'update_welcome_msg') {
      // Process welcome message update
      adminStates.delete(userId); // Clear the state
      
      if (!text || text.length < 10) {
        return ctx.reply('❌ Please provide a valid welcome message (at least 10 characters).');
      }
      
      try {
        // Save the welcome message to database as a bot setting
        const botConfigRef = db.collection('botConfig').doc('welcomeMessage');
        await botConfigRef.set({ 
          message: text,
          updatedAt: new Date().toISOString(),
          updatedBy: userId
        });
        
        await ctx.reply(`✅ Welcome message updated successfully. New users will see this message when they start the bot.`);
      } catch (error) {
        console.error('Error updating welcome message:', error);
        ctx.reply('❌ Error updating welcome message. Please try again.');
      }
      return;
    }
    
    if (adminState === 'add_premium_user') {
      // Process add premium user
      adminStates.delete(userId);
      
      const targetUserId = text.trim();
      if (!targetUserId) {
        return ctx.reply('❌ Please provide a valid user ID.');
      }
      
      try {
        const userRef = db.collection('users').doc(String(targetUserId));
        const userDoc = await userRef.get();
        
        if (!userDoc.exists) {
          return ctx.reply('❌ User not found.');
        }
        
        // Get premium settings from database
        const configRef = db.collection('botConfig').doc('premiumSettings');
        const configDoc = await configRef.get();
        
        // Set default premium values
        let premiumSlots = 20;
        let premiumDuration = 30; // Default 30 days
        
        // Get settings if they exist
        if (configDoc.exists) {
          const settings = configDoc.data();
          if (settings.defaultSlots) {
            premiumSlots = settings.defaultSlots;
          }
          if (settings.durationInDays) {
            premiumDuration = settings.durationInDays;
          }
        }
        
        // Calculate premium expiry date
        const now = new Date();
        const expiryDate = new Date();
        expiryDate.setDate(now.getDate() + premiumDuration);
        
        // Update user to premium with configured settings
        await userRef.update({ 
          premium: true,
          premiumSince: now.toISOString(),
          premiumUntil: expiryDate.toISOString(),
          premiumSlots: premiumSlots,
          premiumDuration: premiumDuration
        });
        
        // Also update their stats
        const userData = userDoc.data();
        const currentStats = userData.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
        currentStats.baseLimit = premiumSlots; // Use configured premium slots
        await userRef.update({ stats: currentStats });
        
        await ctx.reply(`✅ User ${targetUserId} is now a premium user with ${premiumSlots} slots!`);
        
        // Create custom welcome message
        
        let welcomeMessage = `🌟 *Premium Upgrade*\n\n` +
          `Congratulations! Your account has been upgraded to premium status!\n\n` +
          `✨ Benefits:\n` +
          `• ${currentStats.baseLimit} storage slots\n` +
          `• Priority support\n` +
          `• More file formats support\n` +
          `• Faster upload speeds\n\n` +
          `Thank you for your support!`;
          
        // Check if premium welcome message exists in the settings we loaded
        if (configDoc.exists && configDoc.data().welcomeMessage) {
          // Use custom welcome message if exists, with {slots} placeholder replaced
          welcomeMessage = configDoc.data().welcomeMessage.replace('{slots}', currentStats.baseLimit);
        }
        
        // Send notification to the user
        await sendNotificationToUsers(welcomeMessage, targetUserId);
      } catch (error) {
        console.error('Error adding premium user:', error);
        ctx.reply('❌ Error upgrading user. Please try again.');
      }
      return;
    }
    
    if (adminState === 'remove_premium_user') {
      // Process remove premium user
      adminStates.delete(userId);
      
      const targetUserId = text.trim();
      if (!targetUserId) {
        return ctx.reply('❌ Please provide a valid user ID.');
      }
      
      try {
        const userRef = db.collection('users').doc(String(targetUserId));
        const userDoc = await userRef.get();
        
        if (!userDoc.exists) {
          return ctx.reply('❌ User not found.');
        }
        
        const userData = userDoc.data();
        if (!userData.premium) {
          return ctx.reply('⚠️ This user is not a premium user.');
        }
        
        // Remove premium status
        await userRef.update({ 
          premium: false,
          premiumUntil: new Date().toISOString() // Mark when premium ended
        });
        
        // Reset their stats to normal
        const currentStats = userData.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
        currentStats.baseLimit = 2; // Reset to default base slots
        await userRef.update({ stats: currentStats });
        
        await ctx.reply(`✅ Premium status removed from user ${targetUserId}.`);
        
        // Send notification to the user
        await sendNotificationToUsers(
          `⚠️ *Premium Status Update*\n\n` +
          `Your premium subscription has ended. Your account has been reverted to standard status.\n\n` +
          `Current storage slots: ${currentStats.baseLimit + currentStats.referrals.length}\n\n` +
          `You can still use your referral link to earn more slots!`, 
          targetUserId
        );
      } catch (error) {
        console.error('Error removing premium user:', error);
        ctx.reply('❌ Error updating user. Please try again.');
      }
      return;
    }
    
    if (adminState === 'view_user_files') {
      // Process view user files
      adminStates.delete(userId);
      
      const targetUserId = text.trim();
      if (!targetUserId) {
        return ctx.reply('❌ Please provide a valid user ID.');
      }
      
      try {
        const userRef = db.collection('users').doc(String(targetUserId));
        const userDoc = await userRef.get();
        
        if (!userDoc.exists) {
          return ctx.reply('❌ User not found.');
        }
        
        // Fetch user files
        const [files] = await storageBucket.getFiles({ prefix: `uploads/${targetUserId}/` });
        if (files.length === 0) {
          return ctx.reply(`📂 User ${targetUserId} has no uploaded files.`);
        }
        
        let message = `📄 Files uploaded by user ${targetUserId}:\n\n`;
        for (const file of files) {
          const fileName = file.name.split('/').pop();
          message += `• 🔗 [${fileName}](https://firebasestorage.googleapis.com/v0/b/${storageBucket.name}/o/${encodeURIComponent(file.name)}?alt=media)\n`;
        }
        
        message += `\nTotal files: ${files.length}`;
        
        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (error) {
        console.error('Error viewing user files:', error);
        ctx.reply('❌ Error fetching user files. Please try again.');
      }
      return;
    }
    
    if (adminState === 'delete_user_files') {
      // Process delete user files
      adminStates.delete(userId);
      
      const targetUserId = text.trim();
      if (!targetUserId) {
        return ctx.reply('❌ Please provide a valid user ID.');
      }
      
      try {
        const userRef = db.collection('users').doc(String(targetUserId));
        const userDoc = await userRef.get();
        
        if (!userDoc.exists) {
          return ctx.reply('❌ User not found.');
        }
        
        // Fetch and delete user files
        const [files] = await storageBucket.getFiles({ prefix: `uploads/${targetUserId}/` });
        if (files.length === 0) {
          return ctx.reply(`📂 User ${targetUserId} has no files to delete.`);
        }
        
        // Create a deletion confirmation menu
        const confirmationMenu = Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Yes, delete all files', `confirm_delete_${targetUserId}`),
            Markup.button.callback('❌ No, cancel deletion', 'cancel_delete')
          ]
        ]);
        
        await ctx.reply(
          `⚠️ Are you sure you want to delete all ${files.length} files from user ${targetUserId}?`,
          confirmationMenu
        );
      } catch (error) {
        console.error('Error processing delete user files:', error);
        ctx.reply('❌ Error processing request. Please try again.');
      }
      return;
    }
    
    if (adminState === 'premium_default_slots') {
      // Process premium default slots
      adminStates.delete(userId);
      
      const slots = parseInt(text.trim());
      if (isNaN(slots) || slots < 1) {
        return ctx.reply('❌ Please enter a valid number of slots (at least 1).');
      }
      
      try {
        // Save the default premium slots to database
        const configRef = db.collection('botConfig').doc('premiumSettings');
        await configRef.set({ 
          defaultSlots: slots,
          updatedAt: new Date().toISOString(),
          updatedBy: userId
        }, { merge: true });
        
        // Also update all existing premium users
        const premiumUsersSnapshot = await db.collection('users')
          .where('premium', '==', true)
          .get();
        
        if (!premiumUsersSnapshot.empty) {
          let updatedCount = 0;
          
          for (const doc of premiumUsersSnapshot.docs) {
            const userData = doc.data();
            const stats = userData.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
            stats.baseLimit = slots;
            await doc.ref.update({ stats });
            updatedCount++;
          }
          
          await ctx.reply(`✅ Default premium slots updated to ${slots}.\n\nUpdated ${updatedCount} existing premium users.`);
          
          // Send notification to premium users
          const notificationMsg = `🌟 *Premium Update*\n\nYour premium slot allocation has been updated to ${slots} slots!\n\nEnjoy your additional storage!`;
          premiumUsersSnapshot.forEach(doc => {
            const userData = doc.data();
            sendNotificationToUsers(notificationMsg, userData.chatId);
          });
        } else {
          await ctx.reply(`✅ Default premium slots updated to ${slots}.\n\nNo existing premium users to update.`);
        }
      } catch (error) {
        console.error('Error updating premium slots:', error);
        ctx.reply('❌ Error updating premium slots. Please try again.');
      }
      return;
    }
    
    if (adminState === 'premium_duration') {
      // Process premium duration
      adminStates.delete(userId);
      
      const days = parseInt(text.trim());
      if (isNaN(days) || days < 1) {
        return ctx.reply('❌ Please enter a valid number of days (at least 1).');
      }
      
      try {
        // Save the premium duration to database
        const configRef = db.collection('botConfig').doc('premiumSettings');
        await configRef.set({ 
          durationInDays: days,
          updatedAt: new Date().toISOString(),
          updatedBy: userId
        }, { merge: true });
        
        await ctx.reply(`✅ Premium subscription duration updated to ${days} days.\n\nThis will apply to new premium subscriptions.`);
      } catch (error) {
        console.error('Error updating premium duration:', error);
        ctx.reply('❌ Error updating premium duration. Please try again.');
      }
      return;
    }
    
    if (adminState === 'premium_welcome_msg') {
      // Process premium welcome message
      adminStates.delete(userId);
      
      if (!text || text.length < 10) {
        return ctx.reply('❌ Please provide a valid welcome message (at least 10 characters).');
      }
      
      try {
        // Save the premium welcome message to database
        const configRef = db.collection('botConfig').doc('premiumSettings');
        await configRef.set({ 
          welcomeMessage: text,
          updatedAt: new Date().toISOString(),
          updatedBy: userId
        }, { merge: true });
        
        await ctx.reply(`✅ Premium welcome message updated successfully. This message will be sent to users when they are upgraded to premium.`);
      } catch (error) {
        console.error('Error updating premium welcome message:', error);
        ctx.reply('❌ Error updating premium welcome message. Please try again.');
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

// Get Premium handler - Allows users to contact admin for premium access
bot.action('get_premium', async (ctx) => {
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || "Unknown";
  
  // Check if user is already premium
  const userRef = db.collection('users').doc(String(userId));
  const userDoc = await userRef.get();
  
  if (userDoc.exists && userDoc.data().premium) {
    return ctx.reply(
      '✨ *You are already a Premium user!*\n\n' +
      'You already have access to all premium features. Enjoy your premium benefits!',
      { parse_mode: 'Markdown' }
    );
  }
  
  // Create admin notification about premium request with inline buttons
  try {
    // First send confirmation to user
    await ctx.reply(
      '🌟 *Premium Upgrade Request*\n\n' +
      'Your request to become a premium user has been sent to the administrators. ' +
      'An admin will review your request and contact you soon.\n\n' +
      '✨ *Premium Benefits:*\n' +
      '• More storage slots\n' +
      '• Priority support\n' +
      '• Advanced file formats\n' +
      '• Faster upload speeds\n\n' +
      'Thank you for your interest in supporting our service!',
      { parse_mode: 'Markdown' }
    );
    
    // Then notify all admins
    const adminIds = process.env.ADMIN_ID.split(',').map(id => id.trim());
    
    const adminMessage = 
      '🔔 *New Premium Request*\n\n' +
      `👤 User: ${userName}\n` +
      `🆔 ID: ${userId}\n\n` +
      'Use the buttons below to manage this request:';
    
    const premiumRequestButtons = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Approve Premium', `approve_premium_${userId}`),
        Markup.button.callback('❌ Deny Request', `deny_premium_${userId}`)
      ],
      [
        Markup.button.callback('💬 Message User', `message_user_${userId}`)
      ]
    ]);
    
    // Send to all admins
    for (const adminId of adminIds) {
      try {
        await bot.telegram.sendMessage(adminId, adminMessage, {
          parse_mode: 'Markdown',
          ...premiumRequestButtons
        });
      } catch (error) {
        console.error(`Failed to send premium request notification to admin ${adminId}:`, error);
      }
    }
    
  } catch (error) {
    console.error('Error handling premium request:', error);
    ctx.reply('❌ Error processing your premium request. Please try again later.');
  }
});

// Advanced Options handler
bot.action('advanced_options', async (ctx) => {
  const userId = ctx.from.id;
  
  // Create advanced options menu
  const advancedOptionsMenu = Markup.inlineKeyboard([
    [
      Markup.button.callback('🔔 Notification Settings', 'notification_settings'),
      Markup.button.callback('🔐 Privacy Options', 'privacy_options')
    ],
    [
      Markup.button.callback('⚙️ File Type Preferences', 'file_preferences'),
      Markup.button.callback('🎨 Display Settings', 'display_settings')
    ],
    [
      Markup.button.callback('📱 Account Settings', 'account_settings'),
      Markup.button.callback('🔧 Technical Support', 'tech_support')
    ],
    [
      Markup.button.callback('⬅️ Back to Main Menu', 'back_to_main')
    ]
  ]);
  
  await ctx.reply(
    '⚙️ *Advanced Options*\n\n' +
    'Customize your bot experience with these advanced settings and options:',
    { 
      parse_mode: 'Markdown',
      ...advancedOptionsMenu
    }
  );
});

// Back to main menu handler
bot.action('back_to_main', async (ctx) => {
  await ctx.reply(
    '🚀 *Welcome back to the main menu!*\n\n' +
    'Select an option from the menu below:',
    { 
      parse_mode: 'Markdown',
      ...userMenu
    }
  );
});

// Privacy Options handler
bot.action('privacy_options', async (ctx) => {
  const userId = ctx.from.id;
  
  await ctx.reply(
    '🔐 *Privacy Settings*\n\n' +
    'Control your data and privacy options:\n\n' +
    '• Your files are stored securely in our cloud storage\n' +
    '• Your personal information is never shared with third parties\n' +
    '• You can request deletion of all your data at any time',
    { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🗑️ Delete All My Data', 'delete_my_data'),
          Markup.button.callback('📋 Request My Data', 'request_my_data')
        ],
        [
          Markup.button.callback('⬅️ Back to Advanced Options', 'advanced_options')
        ]
      ])
    }
  );
});

// Display settings handler
bot.action('display_settings', async (ctx) => {
  await ctx.reply(
    '🎨 *Display Settings*\n\n' +
    'Customize how content is displayed to you.\n\n' +
    '*Current Settings:*\n' +
    '• Language: English\n' +
    '• Time Format: 24-hour\n' +
    '• Link Preview: Enabled',
    { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🔄 Reset to Default', 'reset_display'),
          Markup.button.callback('⬅️ Back', 'advanced_options')
        ]
      ])
    }
  );
});

// Account Settings handler
bot.action('account_settings', async (ctx) => {
  const userId = ctx.from.id;
  const userRef = db.collection('users').doc(String(userId));
  const userDoc = await userRef.get();
  
  if (!userDoc.exists) {
    return ctx.reply('❌ Error: User data not found.');
  }
  
  const userData = userDoc.data();
  const joinDate = userData.joinedAt ? new Date(userData.joinedAt).toLocaleDateString() : 'Unknown';
  const premiumStatus = userData.premium ? '✅ Premium' : '❌ Standard';
  const premiumExpiry = userData.premiumUntil ? new Date(userData.premiumUntil).toLocaleDateString() : 'N/A';
  
  await ctx.reply(
    '📱 *Account Settings*\n\n' +
    `User ID: ${userId}\n` +
    `Joined: ${joinDate}\n` +
    `Status: ${premiumStatus}\n` + 
    `Premium Expiry: ${premiumExpiry}\n\n` +
    'You can manage your account settings using the options below:',
    { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('👑 Upgrade to Premium', 'get_premium'),
          Markup.button.callback('📞 Contact Support', 'contact')
        ],
        [
          Markup.button.callback('⬅️ Back to Advanced Options', 'advanced_options')
        ]
      ])
    }
  );
});

// File Preferences Handler
bot.action('file_preferences', async (ctx) => {
  await ctx.reply(
    '⚙️ *File Type Preferences*\n\n' +
    'Premium users can upload these file types:\n' +
    '• HTML - ✅ Always Enabled\n' +
    '• ZIP - ✅ Always Enabled\n' +
    '• CSS - ✅ Premium Only\n' +
    '• JS - ✅ Premium Only\n\n' +
    'Standard users are limited to HTML and ZIP files only.',
    { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('👑 Get Premium', 'get_premium'),
          Markup.button.callback('⬅️ Back', 'advanced_options')
        ]
      ])
    }
  );
});

// Notification Settings handler
bot.action('notification_settings', async (ctx) => {
  const userId = ctx.from.id;
  const userRef = db.collection('users').doc(String(userId));
  const userDoc = await userRef.get();
  
  const currentSetting = userDoc.exists && userDoc.data().notifications === false ? false : true;
  
  const notificationButtons = Markup.inlineKeyboard([
    [
      Markup.button.callback(currentSetting ? '✅ Notifications ON' : '⚪ Notifications ON', 'notifications_on'),
      Markup.button.callback(!currentSetting ? '✅ Notifications OFF' : '⚪ Notifications OFF', 'notifications_off')
    ],
    [
      Markup.button.callback('⬅️ Back to Advanced Options', 'advanced_options')
    ]
  ]);
  
  await ctx.reply(
    '🔔 *Notification Settings*\n\n' +
    'Control when and how you receive updates from the bot.\n\n' +
    `Current setting: ${currentSetting ? 'Notifications ON' : 'Notifications OFF'}`,
    { 
      parse_mode: 'Markdown',
      ...notificationButtons
    }
  );
});

// Turn notifications on/off
bot.action('notifications_on', async (ctx) => {
  const userId = ctx.from.id;
  await db.collection('users').doc(String(userId)).update({ notifications: true });
  await ctx.answerCbQuery('Notifications turned ON');
  
  // Update the notification settings display
  await ctx.editMessageText(
    '🔔 *Notification Settings*\n\n' +
    'Control when and how you receive updates from the bot.\n\n' +
    'Current setting: Notifications ON',
    { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Notifications ON', 'notifications_on'),
          Markup.button.callback('⚪ Notifications OFF', 'notifications_off')
        ],
        [
          Markup.button.callback('⬅️ Back to Advanced Options', 'advanced_options')
        ]
      ])
    }
  );
});

bot.action('notifications_off', async (ctx) => {
  const userId = ctx.from.id;
  await db.collection('users').doc(String(userId)).update({ notifications: false });
  await ctx.answerCbQuery('Notifications turned OFF');
  
  // Update the notification settings display
  await ctx.editMessageText(
    '🔔 *Notification Settings*\n\n' +
    'Control when and how you receive updates from the bot.\n\n' +
    'Current setting: Notifications OFF',
    { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('⚪ Notifications ON', 'notifications_on'),
          Markup.button.callback('✅ Notifications OFF', 'notifications_off')
        ],
        [
          Markup.button.callback('⬅️ Back to Advanced Options', 'advanced_options')
        ]
      ])
    }
  );
});

// Technical Support handler
bot.action('tech_support', async (ctx) => {
  await ctx.reply(
    '🔧 *Technical Support*\n\n' +
    'Need help with the bot? Here are some options:\n\n' +
    '1️⃣ *Common Issues*\n' +
    '- Make sure your files are HTML or ZIP format\n' +
    '- File size must be under 20MB\n' +
    '- Check your storage slot availability\n\n' +
    '2️⃣ *Contact Admin*\n' +
    'For unresolved issues, contact our admin directly:\n' +
    '👤 @Gamaspyowner\n\n' +
    '3️⃣ *Premium Support*\n' +
    'Premium users get priority support',
    { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📝 Report a Bug', 'report_bug'),
          Markup.button.callback('📞 Contact Admin', 'contact')
        ],
        [
          Markup.button.callback('⬅️ Back to Advanced Options', 'advanced_options')
        ]
      ])
    }
  );
});

// Report Bug handler
bot.action('report_bug', async (ctx) => {
  // Set user state to report bug mode
  adminStates.set(ctx.from.id, 'report_bug');
  
  await ctx.reply(
    '🐛 *Report a Bug*\n\n' +
    'Please describe the issue you\'re experiencing in detail. Include:\n\n' +
    '- What you were trying to do\n' +
    '- What happened instead\n' +
    '- Any error messages you saw\n\n' +
    'Type your bug report below:',
    { parse_mode: 'Markdown' }
  );
});

// Premium Features Info handler
bot.action('premium_features_info', async (ctx) => {
  // Fetch premium settings to show accurate information
  const configRef = db.collection('botConfig').doc('premiumSettings');
  const configDoc = await configRef.get();
  
  let defaultSlots = 10; // Default value
  let durationInDays = 30; // Default value
  
  if (configDoc.exists) {
    defaultSlots = configDoc.data().defaultSlots || 10;
    durationInDays = configDoc.data().durationInDays || 30;
  }
  
  await ctx.reply(
    '✨ *Premium Features*\n\n' +
    '🌟 *Upgrade Benefits:*\n' +
    `• ${defaultSlots} storage slots (vs 2 for free users)\n` +
    '• Support for more file formats\n' +
    '• Priority support and faster response\n' +
    '• Early access to new features\n' +
    '• Ad-free experience\n\n' +
    `📅 *Subscription Duration:* ${durationInDays} days\n\n` +
    '💰 *How to Get Premium:*\n' +
    'Click the "Get Premium" button in the main menu to request premium access. An admin will review your request and contact you with payment details.',
    { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('👑 Get Premium', 'get_premium'),
          Markup.button.callback('❓ FAQ', 'premium_faq')
        ],
        [
          Markup.button.callback('⬅️ Back to Main Menu', 'back_to_main')
        ]
      ])
    }
  );
});

// Premium FAQ handler
bot.action('premium_faq', async (ctx) => {
  await ctx.reply(
    '❓ *Premium FAQ*\n\n' +
    '*Q: How do I become a premium user?*\n' +
    'A: Click the "Get Premium" button to send a request to admins.\n\n' +
    '*Q: What payment methods are accepted?*\n' +
    'A: Admin will contact you with available payment options.\n\n' +
    '*Q: Can I cancel my premium subscription?*\n' +
    'A: Yes, contact admin to cancel at any time.\n\n' +
    '*Q: Will I lose my files if premium expires?*\n' +
    'A: No, but you may not be able to add new files if over the free limit.\n\n' +
    '*Q: How long does premium last?*\n' +
    'A: Subscription duration is set by admins, typically 30 days.',
    { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('👑 Get Premium', 'get_premium'),
          Markup.button.callback('⬅️ Back', 'premium_features_info')
        ]
      ])
    }
  );
});

// Admin approval handlers for premium requests
bot.action(/approve_premium_(\d+)/, async (ctx) => {
  const adminId = ctx.from.id;
  if (!isAdmin(adminId)) {
    return ctx.answerCbQuery('❌ You are not authorized to perform this action.');
  }
  
  const targetUserId = ctx.match[1];
  
  // Set admin state to add premium user mode with target ID prefilled
  adminStates.set(adminId, 'add_premium_user_prefilled');
  adminStates.set(adminId + '_target', targetUserId);
  
  await ctx.answerCbQuery('✅ Processing premium approval');
  
  // Get premium configuration for slots
  const configRef = db.collection('botConfig').doc('premiumSettings');
  const configDoc = await configRef.get();
  
  let defaultSlots = 10; // Default slots if not configured
  if (configDoc.exists && configDoc.data().defaultSlots) {
    defaultSlots = configDoc.data().defaultSlots;
  }
  
  await ctx.reply(
    `🌟 *Premium Approval Process*\n\n` +
    `User ID: ${targetUserId}\n\n` +
    `Default premium slots: ${defaultSlots}\n\n` +
    `How many slots do you want to give this user? Press enter to use the default (${defaultSlots}), or type a different number:`,
    { parse_mode: 'Markdown' }
  );
});

bot.action(/deny_premium_(\d+)/, async (ctx) => {
  const adminId = ctx.from.id;
  if (!isAdmin(adminId)) {
    return ctx.answerCbQuery('❌ You are not authorized to perform this action.');
  }
  
  const targetUserId = ctx.match[1];
  
  try {
    await ctx.answerCbQuery('✅ Premium request denied');
    
    // Notify user that their premium request was denied
    await sendNotificationToUsers(
      `⚠️ *Premium Request Update*\n\n` +
      `Your request for premium access has been reviewed and cannot be approved at this time.\n\n` +
      `If you have questions, please contact our admin using the Contact Admin button.`,
      targetUserId
    );
    
    await ctx.reply(`Premium request for user ${targetUserId} has been denied and the user has been notified.`);
  } catch (error) {
    console.error('Error denying premium request:', error);
    await ctx.reply('❌ Error processing the denial. Please try again.');
  }
});

bot.action(/message_user_(\d+)/, async (ctx) => {
  const adminId = ctx.from.id;
  if (!isAdmin(adminId)) {
    return ctx.answerCbQuery('❌ You are not authorized to perform this action.');
  }
  
  const targetUserId = ctx.match[1];
  
  // Set admin state to message user mode
  adminStates.set(adminId, 'message_user');
  adminStates.set(adminId + '_target', targetUserId);
  
  await ctx.answerCbQuery('✅ Ready to send message to user');
  
  await ctx.reply(
    `💬 *Direct Message to User*\n\n` +
    `You're about to send a direct message to user ${targetUserId}.\n\n` +
    `Type your message below:`,
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
  
  // Get allowed file types from database
  const configRef = db.collection('botConfig').doc('fileTypes');
  const configDoc = await configRef.get();
  
  let allowedTypes = {
    html: true,
    zip: true,
    js: false,
    css: false
  };
  
  if (configDoc.exists) {
    allowedTypes = { ...allowedTypes, ...configDoc.data() };
  }
  
  // Check if file type is allowed
  const fileExt = file.file_name.split('.').pop().toLowerCase();
  
  if (
    (fileExt === 'html' && !allowedTypes.html) ||
    (fileExt === 'zip' && !allowedTypes.zip) ||
    (fileExt === 'js' && !allowedTypes.js) ||
    (fileExt === 'css' && !allowedTypes.css) ||
    !['html', 'zip', 'js', 'css'].includes(fileExt)
  ) {
    // Create a list of allowed file types for the error message
    const allowedExtList = Object.entries(allowedTypes)
      .filter(([_, isAllowed]) => isAllowed)
      .map(([ext]) => `.${ext.toUpperCase()}`)
      .join(', ');
      
    return ctx.reply(`⚠️ Invalid file type. Currently allowed file types are: ${allowedExtList}`);
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
// Privacy handlers - delete my data
bot.action('delete_my_data', async (ctx) => {
  const userId = ctx.from.id;
  
  // Create a confirmation menu
  const confirmationMenu = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Yes, delete ALL my data', `confirm_all_data_delete_${userId}`),
      Markup.button.callback('❌ Cancel', 'cancel_data_delete')
    ]
  ]);
  
  await ctx.reply(
    '⚠️ *DELETE ALL DATA - CONFIRMATION*\n\n' +
    'This will delete *ALL* your uploaded files and account information. This action *CANNOT* be undone.\n\n' +
    'Are you absolutely sure you want to proceed?',
    { 
      parse_mode: 'Markdown',
      ...confirmationMenu
    }
  );
});

bot.action('cancel_data_delete', async (ctx) => {
  await ctx.answerCbQuery('Data deletion cancelled');
  await ctx.reply(
    '✅ Data deletion cancelled. Your files and account information remain untouched.',
    {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Back to Privacy Settings', 'privacy_options')]
      ])
    }
  );
});

bot.action(/confirm_all_data_delete_(\d+)/, async (ctx) => {
  const userId = ctx.from.id;
  const targetId = ctx.match[1];
  
  // Safety check - make sure user is only deleting their own data
  if (String(userId) !== String(targetId)) {
    return ctx.answerCbQuery('❌ Error: User ID mismatch');
  }
  
  await ctx.answerCbQuery('Processing data deletion...');
  
  try {
    // 1. Delete all user files
    const [files] = await storageBucket.getFiles({ prefix: `uploads/${userId}/` });
    
    if (files.length > 0) {
      await ctx.reply(
        '🗑️ *Deleting your files...*\n\n' +
        `Found ${files.length} files to delete.`,
        { parse_mode: 'Markdown' }
      );
      
      // Delete files in batches to avoid API limits
      const deletePromises = files.map(file => file.delete());
      await Promise.all(deletePromises);
    }
    
    // 2. Update file count to 0
    const userRef = db.collection('users').doc(String(userId));
    const userDoc = await userRef.get();
    
    if (userDoc.exists) {
      const userData = userDoc.data();
      const currentStats = userData.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
      currentStats.fileCount = 0;
      
      // 3. Mark account as deleted but keep minimal record
      await userRef.update({ 
        stats: currentStats,
        accountDeleted: true,
        deletedAt: new Date().toISOString(),
        notifications: false
      });
    }
    
    await ctx.reply(
      '✅ *Data Deletion Complete*\n\n' +
      'All your files and personal data have been deleted from our system.\n\n' +
      'Your account remains active, but all settings have been reset. You can continue using the bot with default settings or contact an admin if you want your account completely removed.',
      { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⬅️ Back to Main Menu', 'back_to_main')]
        ])
      }
    );
  } catch (error) {
    console.error('Error deleting user data:', error);
    await ctx.reply(
      '❌ *Error During Data Deletion*\n\n' +
      'We encountered a problem while trying to delete your data. Please try again later or contact an admin for assistance.',
      { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⬅️ Back to Privacy Settings', 'privacy_options')]
        ])
      }
    );
  }
});

// Request My Data handler
bot.action('request_my_data', async (ctx) => {
  const userId = ctx.from.id;
  
  try {
    // Get user data
    const userRef = db.collection('users').doc(String(userId));
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      return ctx.reply('❌ Error: User data not found.');
    }
    
    const userData = userDoc.data();
    
    // Get user's files
    const [files] = await storageBucket.getFiles({ prefix: `uploads/${userId}/` });
    
    // Format user data report
    let dataReport = `📊 *Your Data Report*\n\n`;
    
    // Account information
    dataReport += `*Account Information:*\n`;
    dataReport += `👤 User ID: ${userId}\n`;
    dataReport += `📅 Joined: ${userData.joinedAt ? new Date(userData.joinedAt).toLocaleDateString() : 'Unknown'}\n`;
    dataReport += `✨ Premium: ${userData.premium ? 'Yes' : 'No'}\n`;
    if (userData.premium) {
      dataReport += `📆 Premium Until: ${userData.premiumUntil ? new Date(userData.premiumUntil).toLocaleDateString() : 'N/A'}\n`;
    }
    
    // Stats
    dataReport += `\n*Usage Statistics:*\n`;
    if (userData.stats) {
      dataReport += `📁 Files Count: ${userData.stats.fileCount || 0}\n`;
      dataReport += `💾 Storage Slots: ${userData.stats.baseLimit || 2}\n`;
      dataReport += `👥 Referrals: ${userData.stats.referrals ? userData.stats.referrals.length : 0}\n`;
    }
    
    // Files
    dataReport += `\n*Your Files:*\n`;
    if (files.length === 0) {
      dataReport += `No files found.\n`;
    } else {
      for (let i = 0; i < Math.min(files.length, 10); i++) {
        const fileName = files[i].name.split('/').pop();
        dataReport += `• ${fileName}\n`;
      }
      
      if (files.length > 10) {
        dataReport += `...and ${files.length - 10} more files.\n`;
      }
    }
    
    // Privacy information
    dataReport += `\n*Privacy Information:*\n`;
    dataReport += `• To delete your data, use the Delete All My Data option.\n`;
    dataReport += `• You can request a full data export by contacting an admin.\n`;
    dataReport += `• Your data is only used to provide the bot's functionality.\n`;
    
    await ctx.reply(dataReport, { 
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Back to Privacy Settings', 'privacy_options')]
      ])
    });
  } catch (error) {
    console.error('Error generating data report:', error);
    await ctx.reply(
      '❌ *Error Generating Data Report*\n\n' +
      'We encountered a problem while trying to generate your data report. Please try again later or contact an admin for assistance.',
      { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⬅️ Back to Privacy Settings', 'privacy_options')]
        ])
      }
    );
  }
});

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

// Admin: View specific user's files
bot.action('view_user_files', async (ctx) => {
  const adminId = ctx.from.id;
  
  if (!isAdmin(adminId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  adminStates.set(adminId, 'view_user_files');
  await ctx.reply('Please enter the user ID to view their files:');
});

// Admin: Delete user files
bot.action('delete_user_files', async (ctx) => {
  const adminId = ctx.from.id;
  
  if (!isAdmin(adminId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  adminStates.set(adminId, 'delete_user_files');
  await ctx.reply('Please enter the user ID to delete their files:');
});

// Add handlers for bot settings
bot.action('bot_settings', async (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  // Create bot settings menu
  const botSettingsMenu = Markup.inlineKeyboard([
    [
      Markup.button.callback('🔄 Update Welcome Message', 'update_welcome_msg'),
      Markup.button.callback('📝 Edit File Types', 'edit_file_types')
    ],
    [
      Markup.button.callback('🔔 Toggle Notifications', 'toggle_notifications'),
      Markup.button.callback('📊 Set Storage Limits', 'set_storage_limits')
    ],
    [
      Markup.button.callback('◀️ Back to Admin Menu', 'back_to_admin')
    ]
  ]);
  
  await ctx.reply('⚙️ *Bot Settings*\n\nConfigure general bot settings and behavior.', {
    parse_mode: 'Markdown',
    ...botSettingsMenu
  });
});

// Handle file deletion confirmation
bot.action(/^confirm_delete_(.+)$/, async (ctx) => {
  const adminId = ctx.from.id;
  
  if (!isAdmin(adminId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  try {
    const targetUserId = ctx.match[1];
    const [files] = await storageBucket.getFiles({ prefix: `uploads/${targetUserId}/` });
    
    if (files.length === 0) {
      return ctx.reply(`📂 User ${targetUserId} has no files to delete.`);
    }
    
    // Delete all files
    let deletedCount = 0;
    for (const file of files) {
      await file.delete();
      deletedCount++;
      
      // Add small delay to prevent rate limiting
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // Update user file count in the database
    const userRef = db.collection('users').doc(String(targetUserId));
    const userDoc = await userRef.get();
    
    if (userDoc.exists) {
      const userData = userDoc.data();
      const stats = userData.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
      stats.fileCount = 0; // Reset file count
      await userRef.update({ stats });
      
      // Send notification to the user
      await sendNotificationToUsers(
        `⚠️ *Files Removed*\n\n` +
        `An administrator has deleted all your files. If you have questions, please use the "Contact Admin" option.`,
        targetUserId
      );
    }
    
    await ctx.reply(`✅ Successfully deleted ${deletedCount} files from user ${targetUserId}.`);
  } catch (error) {
    console.error('Error deleting user files:', error);
    ctx.reply('❌ Error deleting files. Please try again.');
  }
});

// Cancel deletion
bot.action('cancel_delete', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  await ctx.reply('✅ Deletion cancelled.');
});

// Update welcome message
bot.action('update_welcome_msg', async (ctx) => {
  const adminId = ctx.from.id;
  
  if (!isAdmin(adminId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  adminStates.set(adminId, 'update_welcome_msg');
  await ctx.reply('Please enter the new welcome message for users.\n\nYou can use Markdown formatting and the following variables:\n- {name} - User\'s name\n- {userId} - User\'s ID\n- {botName} - Bot\'s name');
});

// Set storage limits
bot.action('set_storage_limits', async (ctx) => {
  const adminId = ctx.from.id;
  
  if (!isAdmin(adminId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  const storageLimitsMenu = Markup.inlineKeyboard([
    [
      Markup.button.callback('🔄 Default Slots', 'edit_default_slots'),
      Markup.button.callback('👑 Premium Slots', 'edit_premium_slots')
    ],
    [
      Markup.button.callback('⬆️ Max File Size', 'edit_max_file_size'),
      Markup.button.callback('📊 Max Files Per User', 'edit_max_files')
    ],
    [
      Markup.button.callback('◀️ Back to Bot Settings', 'bot_settings')
    ]
  ]);
  
  await ctx.reply('📊 *Storage Limit Settings*\n\nConfigure storage limits for different user types.', {
    parse_mode: 'Markdown',
    ...storageLimitsMenu
  });
});

// Toggle notifications
bot.action('toggle_notifications', async (ctx) => {
  const adminId = ctx.from.id;
  
  if (!isAdmin(adminId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  try {
    // Get current notification settings
    const configRef = db.collection('botConfig').doc('notifications');
    const configDoc = await configRef.get();
    
    let notificationsEnabled = true;
    if (configDoc.exists) {
      notificationsEnabled = configDoc.data().enabled !== false;
    }
    
    // Toggle notifications
    await configRef.set({
      enabled: !notificationsEnabled,
      updatedAt: new Date().toISOString(),
      updatedBy: adminId
    });
    
    await ctx.reply(`✅ Notifications have been ${!notificationsEnabled ? 'enabled' : 'disabled'}.`);
  } catch (error) {
    console.error('Error toggling notifications:', error);
    ctx.reply('❌ Error updating notification settings. Please try again.');
  }
});

// File type handlers
bot.action(/^(enable|disable)_(html|zip|js|css)$/, async (ctx) => {
  const adminId = ctx.from.id;
  
  if (!isAdmin(adminId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  const action = ctx.match[1]; // 'enable' or 'disable'
  const fileType = ctx.match[2]; // 'html', 'zip', 'js', or 'css'
  
  try {
    // Get current file type settings
    const configRef = db.collection('botConfig').doc('fileTypes');
    const configDoc = await configRef.get();
    
    let fileTypes = {};
    if (configDoc.exists) {
      fileTypes = configDoc.data();
    }
    
    // Update file type setting
    fileTypes[fileType] = action === 'enable';
    
    await configRef.set({
      ...fileTypes,
      updatedAt: new Date().toISOString(),
      updatedBy: adminId
    });
    
    await ctx.reply(`✅ ${fileType.toUpperCase()} files have been ${action === 'enable' ? 'enabled' : 'disabled'}.`);
    
    // Return to file type menu
    setTimeout(() => {
      const fileTypeMenu = Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Enable HTML', 'enable_html'),
          Markup.button.callback('❌ Disable HTML', 'disable_html')
        ],
        [
          Markup.button.callback('✅ Enable ZIP', 'enable_zip'),
          Markup.button.callback('❌ Disable ZIP', 'disable_zip')
        ],
        [
          Markup.button.callback('✅ Enable JS', 'enable_js'),
          Markup.button.callback('❌ Disable JS', 'disable_js')
        ],
        [
          Markup.button.callback('✅ Enable CSS', 'enable_css'),
          Markup.button.callback('❌ Disable CSS', 'disable_css')
        ],
        [
          Markup.button.callback('◀️ Back to Bot Settings', 'bot_settings')
        ]
      ]);
      
      ctx.reply('📝 *File Type Settings Updated*\n\nEnable or disable allowed file types for uploads.', {
        parse_mode: 'Markdown',
        ...fileTypeMenu
      });
    }, 1000);
  } catch (error) {
    console.error('Error updating file type settings:', error);
    ctx.reply('❌ Error updating file type settings. Please try again.');
  }
});

// Edit file types
bot.action('edit_file_types', async (ctx) => {
  const adminId = ctx.from.id;
  
  if (!isAdmin(adminId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }
  
  const fileTypeMenu = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Enable HTML', 'enable_html'),
      Markup.button.callback('❌ Disable HTML', 'disable_html')
    ],
    [
      Markup.button.callback('✅ Enable ZIP', 'enable_zip'),
      Markup.button.callback('❌ Disable ZIP', 'disable_zip')
    ],
    [
      Markup.button.callback('✅ Enable JS', 'enable_js'),
      Markup.button.callback('❌ Disable JS', 'disable_js')
    ],
    [
      Markup.button.callback('✅ Enable CSS', 'enable_css'),
      Markup.button.callback('❌ Disable CSS', 'disable_css')
    ],
    [
      Markup.button.callback('◀️ Back to Bot Settings', 'bot_settings')
    ]
  ]);
  
  await ctx.reply('📝 *File Type Settings*\n\nEnable or disable allowed file types for uploads.', {
    parse_mode: 'Markdown',
    ...fileTypeMenu
  });
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
