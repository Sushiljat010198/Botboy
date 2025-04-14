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
  [Markup.button.callback('📂 View All Files', 'view_files')],
  [Markup.button.callback('📊 Total Users', 'total_users')],
  [Markup.button.callback('📈 Referral Stats', 'referral_stats')],
  [Markup.button.callback('📊 Daily Stats', 'daily_stats')],
  [Markup.button.callback('📢 Broadcast Message', 'broadcast')],
  [Markup.button.callback('🎁 Add Slots', 'add_slots')],
  [Markup.button.callback('🚫 Ban User', 'ban_user')],
  [Markup.button.callback('🔓 Unban User', 'unban_user')],
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
  [Markup.button.callback('📤 Upload File', 'upload')],
  [Markup.button.callback('📂 My Files', 'myfiles')],
  [Markup.button.callback('❌ Delete File', 'delete')],
  [Markup.button.callback('🔗 My Refer Link', 'refer')],
  [Markup.button.callback('📞 contact me', 'contact')]
]);

// Handle refer button click
bot.action('refer', async (ctx) => {
  const userId = ctx.from.id;
  const stats = await getUserStats(userId);
  const totalSlots = stats.baseLimit + stats.referrals.length;
  
  ctx.reply(
    `🔗 Your Referral Stats:\n\n` +
    `📊 Total Files: ${stats.fileCount}/${totalSlots}\n` +
    `👥 Total Referrals: ${stats.referrals.length}\n\n` +
    `Share your referral link to get more upload slots:\n` +
    `https://t.me/${ctx.botInfo.username}?start=${userId}`
  );
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
    ctx.reply('Welcome to the HTML Hosting Bot! Use the menu below:', userMenu);
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

bot.action('broadcast', async (ctx) => {
  const userId = ctx.from.id;

  if (!isAdmin(userId)) {
    return ctx.reply('❌ You are not authorized to perform this action.');
  }

  ctx.reply('📢 Please send the message you want to broadcast (Text, Image, or Video).');

  bot.on('message', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;

    const message = ctx.message;
    const usersSnapshot = await db.collection('users').get();
    if (usersSnapshot.empty) {
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
  });
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
  
  ctx.reply('⏳ Uploading your file, please wait...');

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
    ctx.reply(`✅ File uploaded successfully!\n\n🔗 Link: ${fileLink}\n\n📊 Your storage: ${stats.fileCount}/${totalSlots} files used\n\n🔗 Share your referral link to get more slots:\nt.me/${ctx.botInfo.username}?start=${ctx.from.id}\n\n⚠️ For best results, please open this link in Chrome browser.`);
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

  // Ask the user to send the file name they want to delete
  ctx.reply('Please provide the name of the file you want to delete. Make sure it matches the exact name of the file.');

  // Handle the response from the user
  bot.on('text', async (ctx) => {
    const fileName = ctx.message.text.trim();

    if (!fileName) {
      return ctx.reply('❌ Please specify the file name to delete.');
    }

    try {
      const fileRef = storageBucket.file(`uploads/${userId}/${fileName}`);
      
      // Check if the file exists before attempting to delete it
      const [exists] = await fileRef.exists();
      if (!exists) {
        return ctx.reply(`❌ File ${fileName} not found.`);
      }

      // Delete the file
      await fileRef.delete();
      ctx.reply(`✅ File ${fileName} deleted successfully.`);
    } catch (error) {
      ctx.reply(`❌ Error deleting file ${fileName}.`);
      console.error(error);
    }
  });
});


app.listen(port, () => {
  console.log(`✅ Web server running on http://localhost:${port}`);
});

// Start the bot
bot.launch({
  polling: true
});
