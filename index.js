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
  [Markup.button.callback('📢 Broadcast Message', 'broadcast')],
  [Markup.button.callback('🚫 Ban User', 'ban_user')],
  [Markup.button.callback('🔓 Unban User', 'unban_user')],
]);

// User Panel Menu (only upload file option)
const userMenu = Markup.inlineKeyboard([
  [Markup.button.callback('📤 Upload File', 'upload')],
  [Markup.button.callback('📂 My Files', 'myfiles')],
  [Markup.button.callback('❌ Delete File', 'delete')],
  [Markup.button.callback('📞 contact me', 'contact')]
]);

// Start command
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || "Unknown";

  if (isBanned(userId)) {
    return ctx.reply('❌ You are banned from using this bot.');
  }

  users.add(userId); // Track user who interacts with the bot

  // Firestore me user add karne ka code
  const userRef = db.collection('users').doc(String(userId));
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    await userRef.set({
      chatId: userId,
      name: userName,
      joinedAt: new Date().toISOString(),
    });
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

  let userList = `📊 **Total Users:** ${usersSnapshot.size}\n\n`;
  usersSnapshot.forEach((doc) => {
    const user = doc.data();
    userList += `👤 **Name:** ${user.name || 'Unknown'}\n💬 **Chat ID:** ${user.chatId}\n\n`;
  });

  ctx.reply(userList, { parse_mode: 'Markdown' });
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
  if (isBanned(ctx.from.id)) {
    return ctx.reply('❌ You are banned from using this bot.');
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

    await fileRef.save(fileStream, {
      contentType: file.mime_type,
      metadata: { firebaseStorageDownloadTokens: 'token' }
    });

    const fileLink = `https://firebasestorage.googleapis.com/v0/b/${storageBucket.name}/o/${encodeURIComponent(fileRef.name)}?alt=media&token=token`;
    ctx.reply(`✅ File uploaded successfully!\n🔗 Link: ${fileLink}`);
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
