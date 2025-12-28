import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import cron from 'node-cron';
import XLSX from 'xlsx';
import { MongoClient } from 'mongodb';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const MB = require('./mbbank/dist/index.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

// Telegram Bot Token
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// MB Bank API credentials from .env (mutable for runtime updates)
const MB_API_KEY = process.env.KEY_API_CA_NHAN;
let MB_USERNAME = process.env.MB_USERNAME;
let MB_PASSWORD = process.env.MB_PASSWORD;
let MB_BANK_CARD_DEFAULT = process.env.MB_BANK_CARD_DEFAULT;
const MB_API_URL_V3 = process.env.API_CA_NHAN_URL_V3;
const MB_API_URL_V1 = process.env.API_CA_NHAN_URL_V1;

// API Canhan configuration
const API_CANHAN_KEY = process.env.API_CANHAN_KEY;
const API_CANHAN_BASE_URL = process.env.API_CANHAN_BASE_URL;

// MongoDB configuration
const MONGO_URI = process.env.MONGO_URI;
const MONGO_DB_NAME = process.env.MONGO_DB_NAME;
const ORDER_COLLECTION = 'orders';

// Server API configuration
const SERVER_API_URL = process.env.SERVER_API_URL ;
const BOT_API_KEY = process.env.BOT_API_KEY;

// Bot CheckNotifiOrder configuration
const CHECK_NOTIFI_ORDER_BOT_TOKEN = process.env.CHECK_NOTIFI_ORDER_BOT_TOKEN;
const CHECK_NOTIFI_ORDER_CHAT_ID = process.env.CHECK_NOTIFI_ORDER_CHAT_ID; // Will be set when bot starts

// Track last cron check time
let lastCronCheckTime = null;

// MB Bank instance (cached)
let mbInstance = null;
let mbLoginTime = null;
const MB_LOGIN_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// Initialize MB Bank instance
const getMBInstance = async () => {
  if (!MB_USERNAME || !MB_PASSWORD) {
    throw new Error('Vui lòng cấu hình MB_USERNAME và MB_PASSWORD trong file .env');
  }

  // Check if we need to create a new instance or re-login
  const now = Date.now();
  if (!mbInstance || !mbLoginTime || (now - mbLoginTime) > MB_LOGIN_CACHE_DURATION) {
    console.log('🔄 Đang khởi tạo/kết nối lại MB Bank...');
    mbInstance = new MB({
      username: MB_USERNAME,
      password: MB_PASSWORD,
    });
    await mbInstance.login();
    mbLoginTime = now;
    console.log('✅ Đã đăng nhập MB Bank thành công');
  }

  return mbInstance;
};

// Helper function to format date for MB Bank API (DD/MM/YYYY)
const formatDateForMB = (date) => {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
};

// Convert MB Bank library format to API v3 format (transactions)
const convertToAPIv3Format = (mbTransaction) => {
  // Check if credit amount exists and is greater than 0
  const creditAmount = mbTransaction.creditAmount || '0';
  const debitAmount = mbTransaction.debitAmount || '0';
  const creditNum = parseFloat(String(creditAmount).replace(/[^0-9.-]/g, '')) || 0;
  const isCredit = creditNum > 0;
  const amount = isCredit ? creditAmount : debitAmount;
  
  // Format transactionDate: "DD/MM/YYYY HH:mm:ss"
  // MB Bank library returns transactionDate as "DD/MM/YYYY HH:mm:ss" or "DD/MM/YYYY"
  const txDateStr = mbTransaction.transactionDate || '';
  const txParts = txDateStr.split(' ');
  const transactionDate = txParts.length > 1 ? txDateStr : (txDateStr ? `${txDateStr} 00:00:00` : '');
  
  return {
    transactionID: mbTransaction.refNo || mbTransaction.transactionId || '',
    amount: amount || '0',
    description: mbTransaction.transactionDesc || mbTransaction.description || '',
    transactionDate: transactionDate,
    type: isCredit ? 'IN' : 'OUT',
  };
};

// Convert MB Bank library format to API v1 format (TranList)
const convertToAPIv1Format = (mbTransaction) => {
  // MB Bank library returns: postDate, transactionDate (both are strings like "DD/MM/YYYY HH:mm:ss" or just "DD/MM/YYYY")
  // Parse dates
  const postDateStr = mbTransaction.postDate || '';
  const txDateStr = mbTransaction.transactionDate || '';
  
  // Split date and time if they contain space
  const postParts = postDateStr.split(' ');
  const postingDate = postParts.length > 1 ? postDateStr : (postDateStr ? `${postDateStr} 00:00:00` : '');
  
  const txParts = txDateStr.split(' ');
  const transactionDate = txParts.length > 1 ? txDateStr : (txDateStr ? `${txDateStr} 00:00:00` : '');
  
  const refNo = mbTransaction.refNo || '';
  // Extract tranId from refNo (remove suffix like D85)
  const tranId = refNo.replace(/D\d+$/, '') || refNo;
  
  return {
    refNo: refNo,
    tranId: tranId,
    postingDate: postingDate,
    transactionDate: transactionDate,
    accountNo: mbTransaction.accountNumber || '',
    creditAmount: mbTransaction.creditAmount || '0',
    debitAmount: mbTransaction.debitAmount || '0',
    currency: mbTransaction.transactionCurrency || 'VND',
    description: mbTransaction.transactionDesc || mbTransaction.description || '',
    availableBalance: mbTransaction.balanceAvailable || '0',
    beneficiaryAccount: mbTransaction.toAccountNumber || '',
  };
};

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

// Store users who want to receive auto-check notifications
const subscribedUsers = new Set();

// Store chat IDs that receive notifications from CheckNotifiOrder bot
const notifiOrderChatIds = new Set();

// File to store last transaction
const LAST_TRANSACTION_FILE = path.join(__dirname, 'last_transaction.json');
const SUBSCRIBERS_FILE = path.join(__dirname, 'subscribers.json');
const NOTIFI_ORDER_CHAT_IDS_FILE = path.join(__dirname, 'notifi_order_chat_ids.json');
const PENDING_NOTIFICATIONS_FILE = path.join(__dirname, 'pending_notifications.json');
const CONFIG_FILE = path.join(__dirname, '.env');
const API_METHOD_FILE = path.join(__dirname, 'api_method.json');

// API Method tracking (default: 'mbbank', fallback: 'apicanhan')
let currentApiMethod = 'mbbank'; // 'mbbank' or 'apicanhan'

// Store pending notifications (orders that were updated but notification failed)
const pendingNotifications = new Map();

const persistJsonToFile = (filePath, data, description) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    if (description) {
      console.log(`💾 Đã lưu ${description} vào ${path.basename(filePath)}`);
    }
  } catch (error) {
    console.error(`❌ Lỗi khi lưu ${description || 'dữ liệu'}:`, error.message);
  }
};

const readJsonFromFile = (filePath, description) => {
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (description) {
        console.log(`📂 Đã tải ${description} từ ${path.basename(filePath)}`);
      }
      return data;
    }
  } catch (error) {
    console.error(`❌ Lỗi khi đọc ${description || 'dữ liệu'}:`, error.message);
  }
  return null;
};

// Load pending notifications from file
const loadPendingNotifications = () => {
  const data = readJsonFromFile(PENDING_NOTIFICATIONS_FILE, 'danh sách đơn hàng chưa gửi thông báo');
  if (data && Array.isArray(data)) {
    data.forEach((item) => {
      if (item && item.orderId) {
        pendingNotifications.set(String(item.orderId), {
          orderId: item.orderId,
          orderData: item.orderData,
          transactionId: item.transactionId,
          createdAt: item.createdAt || new Date().toISOString(),
          retryCount: item.retryCount || 0,
        });
      }
    });
    if (pendingNotifications.size > 0) {
      console.log(`📋 Đã tải ${pendingNotifications.size} đơn hàng chưa gửi thông báo`);
    }
  }
};

// Load API method from file
const loadApiMethod = () => {
  const data = readJsonFromFile(API_METHOD_FILE, 'phương thức API');
  if (data && data.method && (data.method === 'mbbank' || data.method === 'apicanhan')) {
    currentApiMethod = data.method;
    console.log(`📡 Phương thức API hiện tại: ${currentApiMethod}`);
  }
};

// Save API method to file
const saveApiMethod = (method) => {
  if (method !== 'mbbank' && method !== 'apicanhan') {
    console.error('❌ Phương thức API không hợp lệ:', method);
    return false;
  }
  currentApiMethod = method;
  persistJsonToFile(API_METHOD_FILE, { method }, 'phương thức API');
  console.log(`✅ Đã chuyển sang phương thức API: ${method}`);
  return true;
};

// Save pending notifications to file
const savePendingNotifications = () => {
  const data = Array.from(pendingNotifications.values());
  persistJsonToFile(PENDING_NOTIFICATIONS_FILE, data, 'danh sách đơn hàng chưa gửi thông báo');
};

// Add order to pending notifications
const addPendingNotification = (orderId, orderData, transactionId = null) => {
  const key = String(orderId);
  const existing = pendingNotifications.get(key);
  pendingNotifications.set(key, {
    orderId: String(orderId),
    orderData,
    transactionId: transactionId || null,
    createdAt: existing?.createdAt || new Date().toISOString(),
    retryCount: existing?.retryCount || 0,
  });
  savePendingNotifications();
  console.log(`📝 Đã thêm đơn hàng ${orderId} vào danh sách chờ gửi thông báo`);
};

// Remove order from pending notifications
const removePendingNotification = (orderId) => {
  const key = String(orderId);
  if (pendingNotifications.has(key)) {
    pendingNotifications.delete(key);
    savePendingNotifications();
    console.log(`✅ Đã xóa đơn hàng ${orderId} khỏi danh sách chờ gửi thông báo`);
    return true;
  }
  return false;
};

// Helper to normalize transaction from API v3 format to internal format
const normalizeTransaction = (apiTx) => {
  // Parse transactionDate to extract date and time (format: "13/11/2025 18:17:07")
  const txDate = apiTx.transactionDate || '';
  const dateTimeParts = txDate.split(' ');
  const datePart = dateTimeParts[0] || '';
  const timePart = dateTimeParts[1] || '';
  
  // API v3 uses 'type' field: "IN" for credit, "OUT" for debit
  const isCredit = apiTx.type === 'IN';
  const amount = apiTx.amount || '0';
  
  return {
    refNo: apiTx.transactionID || '',
    transactionId: apiTx.transactionID || '',
    tranId: apiTx.transactionID || '',
    transactionID: apiTx.transactionID || '',
    postingDate: '',
    transactionDate: datePart,
    transactionTime: timePart,
    accountNo: '',
    creditAmount: isCredit ? amount : '0',
    debitAmount: isCredit ? '0' : amount,
    currency: 'VND',
    transactionCurrency: 'VND',
    description: apiTx.description || '',
    transactionDesc: apiTx.description || '',
    availableBalance: '0',
    balanceAvailable: '0',
    beneficiaryAccount: '',
    type: apiTx.type || 'IN',
    amount: amount,
  };
};

// Helper to generate consistent transaction ID
const getTransactionId = (tx = {}) => {
  // Use transactionID as primary identifier (API v3)
  if (tx.transactionID) return tx.transactionID;
  if (tx.transactionId) return tx.transactionId;
  if (tx.refNo) return tx.refNo;
  if (tx.tranId) return tx.tranId;
  
  // Fallback to composite ID
  return `${tx.transactionDate || ''}_${tx.transactionTime || ''}_${tx.creditAmount || 0}_${tx.debitAmount || 0}_${tx.transactionDesc || tx.description || ''}`;
};

let lastTransactionCache = null;

// Function to load last transaction from file
const loadLastTransaction = (silent = false) => {
  if (lastTransactionCache) {
    return lastTransactionCache;
  }

  const data = readJsonFromFile(
    LAST_TRANSACTION_FILE,
    silent ? null : 'giao dịch cuối cùng'
  );
  if (data) {
    lastTransactionCache = data;
  }
  return data;
};

// Function to save last transaction to file
const saveLastTransaction = (transaction) => {
  if (!transaction) return;
  persistJsonToFile(LAST_TRANSACTION_FILE, transaction, 'giao dịch cuối cùng');
  lastTransactionCache = transaction;
};

const normalizeAmount = (value) => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const cleaned = value.toString().replace(/[^0-9.-]/g, '');
  const parsed = parseFloat(cleaned);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const formatAmountForNotification = (amount, currency = 'VND') => {
  const numericAmount = normalizeAmount(amount);
  const formatted = new Intl.NumberFormat('vi-VN').format(Math.abs(numericAmount));
  if (!currency || currency.toUpperCase() === 'VND') {
    return `${formatted} đ`;
  }
  return `${formatted} ${currency}`;
};

const extractCustomerName = (transaction, isCredit) => {
  const candidates = isCredit
    ? [
        transaction.fromAccountName,
        transaction.fromCustomerName,
        transaction.transactionOwnerName,
        transaction.counterAccountName,
        transaction.descriptionOwner,
        transaction.toAccountName,
        transaction.accountName,
      ]
    : [
        transaction.toAccountName,
        transaction.toCustomerName,
        transaction.counterAccountName,
        transaction.transactionOwnerName,
      ];

  for (const name of candidates) {
    if (name && typeof name === 'string' && name.trim().length > 0) {
      return name.trim();
    }
  }
  return null;
};

const formatTransactionNotification = (transaction, accountNumber) => {
  // API v3 uses 'type' field: "IN" for credit, "OUT" for debit
  const isCredit = transaction.type === 'IN' || normalizeAmount(transaction.creditAmount) > 0;
  const amountValue = transaction.amount || (isCredit ? transaction.creditAmount : transaction.debitAmount);
  const amountFormatted = formatAmountForNotification(amountValue, transaction.transactionCurrency || transaction.currency || 'VND');
  const amountLine = isCredit ? `💰Tiền vào: +${amountFormatted}` : `💸Tiền ra: -${amountFormatted}`;

  const bankName = 'MB BANK';

  const date = transaction.transactionDate || '';
  const time = transaction.transactionTime || '';
  let datetime = '';
  if (date && time) {
    datetime = `${date} ${time}`;
  } else if (date || time) {
    datetime = date || time;
  }

  let customerName = null;
  let content = (transaction.transactionDesc || transaction.description || transaction.content || '').trim();

  if (content) {
    const tuRegex = /(TỪ|TU)\s*:\s*([^.;\n]+)/i;
    const match = content.match(tuRegex);
    if (match) {
      const extractedName = match[2]?.trim();
      if (extractedName) {
        customerName = extractedName;
      }
      content = `${content.slice(0, match.index)}${content.slice(match.index + match[0].length)}`;
    }

    content = content.replace(/\s+/g, ' ').trim();
    content = content.replace(/[.\s]+$/g, '').trim();
  }

  if (!customerName && transaction.beneficiaryAccount) {
    customerName = transaction.beneficiaryAccount;
  }

  if (!content) {
    content = 'Không có nội dung';
  }

  // Get transaction ID
  const transactionId = transaction.transactionID || transaction.transactionId || transaction.refNo || transaction.tranId || '';

  const messageParts = [
    '🔔 CÓ GIAO DỊCH MỚI',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '',
    amountLine,
    '',
    `🏦 Tài Khoản: ${accountNumber} tại ${bankName}`,
  ];

  if (datetime) {
    messageParts.push('', `📅 Lúc: ${datetime}`);
  }

  if (transactionId) {
    messageParts.push('', `💰Transaction ID: ${transactionId}`);
  }

  if (customerName) {
    messageParts.push('', `🧑‍💼Từ: ${customerName}`);
  }

  messageParts.push('', `➡️Nội Dung CK: ${content}`);

  return messageParts.join('\n');
};

// Add middleware to log all updates (must be before command handlers)
bot.use((ctx, next) => {
  console.log('📨 Nhận update:', ctx.updateType, 'từ user:', ctx.from?.id, ctx.from?.username || 'N/A');
  if (ctx.message) {
    console.log('💬 Message:', ctx.message.text || ctx.message.caption || 'N/A');
  }

  const chatId = ctx.chat?.id;
  if (chatId) {
    const result = addSubscriber(String(chatId));
    if (result.reason === 'added') {
      console.log(`📥 Tự động đăng ký chat ${chatId} nhận thông báo.`);
    }
  }

  return next();
});

// Helper function to format date
const formatDate = (date) => {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
};

// Helper function to format currency
const formatCurrency = (amount, currency = 'VND') => {
  if (!amount) return '0';
  return new Intl.NumberFormat('vi-VN').format(amount) + ' ' + currency;
};

// Helper function to format transaction message (for API v1 with full details)
const formatTransaction = (transaction, index) => {
  // Check if transaction has creditAmount/debitAmount (API v1) or type (API v3)
  const isCredit = normalizeAmount(transaction.creditAmount) > 0 || transaction.type === 'IN';
  const creditAmount = normalizeAmount(transaction.creditAmount);
  const debitAmount = normalizeAmount(transaction.debitAmount);
  
  const transactionDate = transaction.transactionDate && transaction.transactionTime 
    ? `${transaction.transactionDate} ${transaction.transactionTime}`
    : transaction.transactionDate || 'N/A';
  
  const transactionId = transaction.transactionID || transaction.transactionId || transaction.tranId || '';
  const transactionType = transaction.type || (isCredit ? 'IN' : 'OUT');
  const balance = normalizeAmount(transaction.availableBalance || transaction.balanceAvailable);
  
  let result = `
${index}. 
Ma Giao Dich: ${transactionId}`;
  
  // Chỉ hiển thị Số Tiền Nhận khi có creditAmount > 0
  if (creditAmount > 0) {
    result += `
So Tien Nhan: ${formatCurrency(creditAmount, 'VND')}`;
  }
  
  result += `
So Du Kha Dung: ${formatCurrency(balance, 'VND')}
Noi Dung CK: ${transaction.transactionDesc || transaction.description || 'N/A'}
Ngay Giao Dich: ${transactionDate}
So Tai Khoan: ${transaction.accountNo || 'N/A'}
Loai: ${transactionType}`;
  
  result += `
`;
  
  return result;
};

// Helper to normalize transaction from API v1 format to internal format
const normalizeTransactionV1 = (apiTx) => {
  // Parse transactionDate to extract date and time (format: "14/11/2025 19:31:57")
  const txDate = apiTx.transactionDate || '';
  const dateTimeParts = txDate.split(' ');
  const datePart = dateTimeParts[0] || '';
  const timePart = dateTimeParts[1] || '';
  
  // Parse postingDate
  const postDate = apiTx.postingDate || '';
  const postDateParts = postDate.split(' ');
  const postDatePart = postDateParts[0] || '';
  const postTimePart = postDateParts[1] || '';
  
  return {
    refNo: apiTx.refNo || apiTx.tranId || '',
    transactionId: apiTx.tranId || apiTx.refNo || '',
    tranId: apiTx.tranId || apiTx.refNo || '',
    transactionID: apiTx.tranId || apiTx.refNo || '',
    postingDate: postDate,
    postingDateOnly: postDatePart,
    postingTime: postTimePart,
    transactionDate: datePart,
    transactionTime: timePart,
    accountNo: apiTx.accountNo || '',
    creditAmount: apiTx.creditAmount || '0',
    debitAmount: apiTx.debitAmount || '0',
    currency: apiTx.currency || 'VND',
    transactionCurrency: apiTx.currency || 'VND',
    description: apiTx.description || '',
    transactionDesc: apiTx.description || '',
    availableBalance: apiTx.availableBalance || '0',
    balanceAvailable: apiTx.availableBalance || '0',
    beneficiaryAccount: apiTx.beneficiaryAccount || '',
    type: normalizeAmount(apiTx.creditAmount) > 0 ? 'IN' : 'OUT',
    amount: normalizeAmount(apiTx.creditAmount) > 0 ? apiTx.creditAmount : apiTx.debitAmount,
  };
};

// Function to fetch transactions from MB Bank library (for cron job) - returns API v3 format
const fetchTransactionsV3 = async (accountNumber) => {
  if (!MB_USERNAME || !MB_PASSWORD) {
    throw new Error('Vui lòng cấu hình MB_USERNAME và MB_PASSWORD trong file .env');
  }

  try {
    const mb = await getMBInstance();
    const accountNo = accountNumber || MB_BANK_CARD_DEFAULT;
    
    // Get date range: last 7 days (tăng từ 3 lên 7 để đảm bảo không bỏ sót giao dịch)
    // Sử dụng timezone Việt Nam để đảm bảo tính toán ngày chính xác
    const now = new Date();
    const vietnamTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
    const today = new Date(vietnamTime.getFullYear(), vietnamTime.getMonth(), vietnamTime.getDate());
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(today.getDate() - 7);
    
    const fromDate = formatDateForMB(sevenDaysAgo);
    const toDate = formatDateForMB(today);
    
    console.log(`📡 Đang lấy giao dịch từ MB Bank với tài khoản ${accountNo} (${fromDate} - ${toDate})`);

    const mbTransactions = await mb.getTransactionsHistory({
      accountNumber: accountNo,
      fromDate: fromDate,
      toDate: toDate,
    });

    if (!mbTransactions || mbTransactions.length === 0) {
      return [];
    }

    // Convert MB Bank format to API v3 format, then normalize
    const apiV3Transactions = mbTransactions.map(convertToAPIv3Format);
    const normalizedTransactions = apiV3Transactions.map(normalizeTransaction);
    
    // Sort by transaction date (newest first)
    normalizedTransactions.sort((a, b) => {
      const dateA = new Date(`${a.transactionDate} ${a.transactionTime || '00:00:00'}`);
      const dateB = new Date(`${b.transactionDate} ${b.transactionTime || '00:00:00'}`);
      return dateB - dateA;
    });

    return normalizedTransactions;
  } catch (error) {
    console.error('❌ Lỗi khi lấy giao dịch từ MB Bank:', error);
    throw new Error(`Lỗi kết nối MB Bank: ${error.message}`);
  }
};

// Function to fetch transactions from MB Bank library (for transaction history commands) - returns API v1 format
const fetchTransactionsV1 = async (accountNumber, fromDate = null, toDate = null) => {
  if (!MB_USERNAME || !MB_PASSWORD) {
    throw new Error('Vui lòng cấu hình MB_USERNAME và MB_PASSWORD trong file .env');
  }

  try {
    const mb = await getMBInstance();
    const accountNo = accountNumber || MB_BANK_CARD_DEFAULT;
    
    // Get date range: default to last 30 days if not provided
    let fromDateStr, toDateStr;
    if (fromDate && toDate) {
      fromDateStr = fromDate;
      toDateStr = toDate;
    } else {
      const today = new Date();
      const thirtyDaysAgo = new Date(today);
      thirtyDaysAgo.setDate(today.getDate() - 30);
      fromDateStr = formatDateForMB(thirtyDaysAgo);
      toDateStr = formatDateForMB(today);
    }
    
    console.log(`📡 Đang lấy lịch sử giao dịch từ MB Bank với tài khoản ${accountNo} (${fromDateStr} - ${toDateStr})`);

    const mbTransactions = await mb.getTransactionsHistory({
      accountNumber: accountNo,
      fromDate: fromDateStr,
      toDate: toDateStr,
    });

    if (!mbTransactions || mbTransactions.length === 0) {
      return [];
    }

    // Convert MB Bank format to API v1 format, then normalize
    const apiV1Transactions = mbTransactions.map(convertToAPIv1Format);
    const normalizedTransactions = apiV1Transactions.map(normalizeTransactionV1);
    
    // Sort by transaction date (newest first)
    normalizedTransactions.sort((a, b) => {
      const dateA = new Date(`${a.transactionDate} ${a.transactionTime || '00:00:00'}`);
      const dateB = new Date(`${b.transactionDate} ${b.transactionTime || '00:00:00'}`);
      return dateB - dateA;
    });

    return normalizedTransactions;
  } catch (error) {
    console.error('❌ Lỗi khi lấy lịch sử giao dịch từ MB Bank:', error);
    throw new Error(`Lỗi kết nối MB Bank: ${error.message}`);
  }
};

// Helper to normalize transaction from API Canhan format to internal format
const normalizeTransactionApicanhan = (apiTx) => {
  // API Canhan returns: postingDate, transactionDate (both are strings like "22/12/2025 00:01:00")
  const postDate = apiTx.postingDate || '';
  const txDate = apiTx.transactionDate || '';
  
  // Split date and time
  const postParts = postDate.split(' ');
  const postingDate = postDate;
  const postingDateOnly = postParts[0] || '';
  const postingTime = postParts[1] || '';
  
  const txParts = txDate.split(' ');
  const transactionDate = txParts[0] || '';
  const transactionTime = txParts[1] || '';
  
  return {
    refNo: apiTx.refNo || apiTx.tranId || '',
    transactionId: apiTx.tranId || apiTx.refNo || '',
    tranId: apiTx.tranId || apiTx.refNo || '',
    transactionID: apiTx.tranId || apiTx.refNo || '',
    postingDate: postingDate,
    postingDateOnly: postingDateOnly,
    postingTime: postingTime,
    transactionDate: transactionDate,
    transactionTime: transactionTime,
    accountNo: apiTx.accountNo || '',
    creditAmount: apiTx.creditAmount || '0',
    debitAmount: apiTx.debitAmount || '0',
    currency: apiTx.currency || 'VND',
    transactionCurrency: apiTx.currency || 'VND',
    description: apiTx.description || '',
    transactionDesc: apiTx.description || '',
    availableBalance: apiTx.availableBalance || '0',
    balanceAvailable: apiTx.availableBalance || '0',
    beneficiaryAccount: apiTx.beneficiaryAccount || '',
    type: normalizeAmount(apiTx.creditAmount) > 0 ? 'IN' : 'OUT',
    amount: normalizeAmount(apiTx.creditAmount) > 0 ? apiTx.creditAmount : apiTx.debitAmount,
  };
};

// Function to fetch transactions from API Canhan
const fetchTransactionsApicanhan = async (accountNumber) => {
  if (!MB_USERNAME || !MB_PASSWORD) {
    throw new Error('Vui lòng cấu hình MB_USERNAME và MB_PASSWORD trong file .env');
  }

  try {
    const accountNo = accountNumber || MB_BANK_CARD_DEFAULT;
    
    // Encode password for URL (handle special characters like !)
    const encodedPassword = encodeURIComponent(MB_PASSWORD);
    
    // Build API URL
    const apiUrl = `${API_CANHAN_BASE_URL}?key=${API_CANHAN_KEY}&username=${MB_USERNAME}&password=${encodedPassword}&accountNo=${accountNo}`;
    
    console.log(`📡 Đang lấy giao dịch từ API Canhan với tài khoản ${accountNo}`);
    
    const response = await axios.get(apiUrl, {
      timeout: 30000,
    });

    if (!response.data) {
      console.log('⚠️ API Canhan trả về dữ liệu rỗng');
      return [];
    }

    // Check for error response
    if (response.data.status === 'error') {
      throw new Error(`API Canhan lỗi: ${response.data.message || 'Unknown error'}`);
    }

    // Check for success response
    if (response.data.status !== 'success') {
      throw new Error(`API Canhan trả về status không hợp lệ: ${response.data.status}`);
    }

    // Get transactions from TranList
    const tranList = response.data.TranList || [];
    
    if (!Array.isArray(tranList) || tranList.length === 0) {
      console.log('📭 API Canhan không có giao dịch nào');
      return [];
    }

    // Normalize transactions
    const normalizedTransactions = tranList.map(normalizeTransactionApicanhan);
    
    // Sort by transaction date (newest first)
    normalizedTransactions.sort((a, b) => {
      const dateA = new Date(`${a.transactionDate} ${a.transactionTime || '00:00:00'}`);
      const dateB = new Date(`${b.transactionDate} ${b.transactionTime || '00:00:00'}`);
      return dateB - dateA;
    });

    console.log(`✅ API Canhan trả về ${normalizedTransactions.length} giao dịch`);
    return normalizedTransactions;
  } catch (error) {
    console.error('❌ Lỗi khi lấy giao dịch từ API Canhan:', error);
    if (error.response) {
      throw new Error(`Lỗi API Canhan: ${error.response.status} - ${error.response.data?.message || error.message}`);
    }
    throw new Error(`Lỗi kết nối API Canhan: ${error.message}`);
  }
};

// Unified function to fetch transactions (no fallback - use current method only)
const fetchTransactions = async (accountNumber, fromDate = null, toDate = null) => {
  // Check current API method and call appropriate function
  // When using apicanhan, completely avoid MB Bank calls
  if (currentApiMethod === 'apicanhan') {
    // Use API Canhan - no MB Bank calls
    console.log(`📡 Sử dụng API Canhan (currentApiMethod: ${currentApiMethod})`);
    return await fetchTransactionsApicanhan(accountNumber);
  } else {
    // Use MB Bank V1 (only when currentApiMethod is 'mbbank')
    console.log(`📡 Sử dụng MB Bank V1 (currentApiMethod: ${currentApiMethod})`);
    return await fetchTransactionsV1(accountNumber, fromDate, toDate);
  }
};

// Unified function to fetch transactions (with fallback) - kept for backward compatibility
const fetchTransactionsWithFallback = async (accountNumber) => {
  // Try current API method first
  try {
    if (currentApiMethod === 'apicanhan') {
      return await fetchTransactionsApicanhan(accountNumber);
    } else {
      return await fetchTransactionsV3(accountNumber);
    }
  } catch (error) {
    console.error(`❌ Lỗi với phương thức API ${currentApiMethod}:`, error.message);
    
    // Fallback to alternative method
    const fallbackMethod = currentApiMethod === 'apicanhan' ? 'mbbank' : 'apicanhan';
    console.log(`🔄 Chuyển sang phương thức API dự phòng: ${fallbackMethod}`);
    
    try {
      if (fallbackMethod === 'apicanhan') {
        return await fetchTransactionsApicanhan(accountNumber);
      } else {
        return await fetchTransactionsV3(accountNumber);
      }
    } catch (fallbackError) {
      console.error(`❌ Lỗi với phương thức API dự phòng ${fallbackMethod}:`, fallbackError.message);
      throw new Error(`Cả hai phương thức API đều lỗi. ${currentApiMethod}: ${error.message}, ${fallbackMethod}: ${fallbackError.message}`);
    }
  }
};

// Start command
bot.start((ctx) => {
  const userId = ctx.from.id;
  const isAdminUser = isAdmin(userId);
  const result = addSubscriber(userId);
  const helpMessage = buildHelpMessage({ isAdminUser });

  let statusMessage = '';
  if (result.reason === 'added') {
    statusMessage = '\n\n✅ Bạn đã được đăng ký nhận thông báo giao dịch tự động.';
  } else if (result.reason === 'exists') {
    statusMessage = '\n\nℹ️ Bạn đã đăng ký nhận thông báo trước đó.';
  } else {
    statusMessage = '\n\n⚠️ Không thể đăng ký nhận thông báo tự động.';
  }

  const adminMessage = isAdminUser
    ? '\n\n🛡️ Bạn là admin. Bạn có thể dùng các lệnh quản trị.'
    : '';

  ctx.reply(helpMessage + statusMessage + adminMessage);
});

// Help command
bot.command('help', (ctx) => {
  const isAdminUser = isAdmin(ctx.from.id);
  ctx.reply(buildHelpMessage({ isAdminUser }));
});

// Login command - Test API connection (HIDDEN)
// bot.command('login', async (ctx) => {
//   if (!requireAdmin(ctx)) return;
//   try {
//     ctx.reply('⏳ Đang kiểm tra kết nối API v3...');
//     
//     const accountNumber = MB_BANK_CARD_DEFAULT || '3999919072004';
//     const transactions = await fetchTransactionsV3(accountNumber);
//     
//     ctx.reply(`✅ Kết nối API v3 thành công! Tìm thấy ${transactions.length} giao dịch.`);
//   } catch (error) {
//     console.error('API test error:', error);
//     ctx.reply(`❌ Lỗi kết nối API: ${error.message}`);
//   }
// });

// Balance command - Get balance from API v1
bot.command('balance', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  try {
    ctx.reply('⏳ Đang lấy thông tin số dư...');
    
    const accountNumber = MB_BANK_CARD_DEFAULT || '3999919072004';
    const transactions = await fetchTransactions(accountNumber);
    
    if (!transactions || transactions.length === 0) {
      return ctx.reply('❌ Không tìm thấy giao dịch nào.');
    }
    
    // Get balance from the most recent transaction
    const latestTx = transactions[0];
    const balance = normalizeAmount(latestTx.availableBalance || latestTx.balanceAvailable);
    const datetime = latestTx.transactionDate && latestTx.transactionTime 
      ? `${latestTx.transactionDate} ${latestTx.transactionTime}`
      : latestTx.transactionDate || 'N/A';
    
    let message = `💰 SỐ DƯ TÀI KHOẢN\n\n`;
    message += `💳 Số tài khoản: ${accountNumber}\n`;
    message += `💵 Số dư khả dụng: ${formatCurrency(balance, latestTx.currency || 'VND')}\n`;
    message += `📅 Cập nhật lần cuối: ${datetime}\n`;
    message += `🆔 Transaction ID: ${latestTx.transactionID || latestTx.transactionId || latestTx.refNo || 'N/A'}\n`;
    message += `📊 Tổng số giao dịch: ${transactions.length}`;
    
    ctx.reply(message);
  } catch (error) {
    console.error('Balance error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Helper function to parse date from DD/MM/YYYY format
const parseDate = (dateStr) => {
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed
  const year = parseInt(parts[2], 10);
  return new Date(year, month, day);
};

// Helper function to check if transaction date is within range
const isTransactionInDateRange = (transaction, fromDate, toDate) => {
  if (!transaction.transactionDate) return false;
  
  const txDateStr = transaction.transactionDate;
  const txDate = parseDate(txDateStr);
  if (!txDate) return false;
  
  // Set time to start of day for comparison
  const from = new Date(fromDate);
  from.setHours(0, 0, 0, 0);
  const to = new Date(toDate);
  to.setHours(23, 59, 59, 999);
  
  const tx = new Date(txDate);
  tx.setHours(0, 0, 0, 0);
  
  return tx >= from && tx <= to;
};

// Transactions command - Get all transactions from API v1
bot.command('transactions', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  try {
    const args = ctx.message.text.split(' ').slice(1);
    
    // Get account number: from argument or default from .env
    const accountNumber = args.length > 0 && args[0] 
      ? args[0] 
      : (MB_BANK_CARD_DEFAULT || '3999919072004');
    
    ctx.reply('⏳ Đang lấy lịch sử giao dịch từ API v1...');
    
    const transactions = await fetchTransactions(accountNumber);
    
    if (!transactions || transactions.length === 0) {
      return ctx.reply(`📭 Không có giao dịch nào\n💳 Tài khoản: ${accountNumber}`);
    }
    
    let message = `📜 LỊCH SỬ GIAO DỊCH (API v1)\n\n`;
    message += `💳 Tài khoản: ${accountNumber}\n`;
    message += `📊 Tổng số giao dịch: ${transactions.length}\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n`;
    
    // Show all transactions
    transactions.forEach((transaction, index) => {
      message += formatTransaction(transaction, index + 1);
      message += `\n`;
    });
    
    // Split message if too long (Telegram limit is 4096 characters)
    if (message.length > 4000) {
      // Split by newlines to avoid breaking transactions
      const lines = message.split('\n');
      let currentChunk = '';
      
      for (const line of lines) {
        if ((currentChunk + line + '\n').length > 4000) {
          if (currentChunk) {
            await ctx.reply(currentChunk.trim());
            currentChunk = '';
          }
        }
        currentChunk += line + '\n';
      }
      
      if (currentChunk.trim()) {
        await ctx.reply(currentChunk.trim());
      }
    } else {
      await ctx.reply(message);
    }
  } catch (error) {
    console.error('Transactions error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Transactions with date range command
bot.command('transactions_with_date', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  try {
    const args = ctx.message.text.split(' ').slice(1);
    
    if (args.length < 3) {
      return ctx.reply(
        `❌ Sai cú pháp!\n\n` +
        `📝 Cú pháp: /transactions_with_date <từ_ngày> - <đến_ngày>\n\n` +
        `📅 Format ngày: DD/MM/YYYY\n` +
        `💡 Ví dụ: /transactions_with_date 22/1/2025 - 22/10/2025`
      );
    }
    
    // Parse date range: "22/1/2025 - 22/10/2025"
    const dateRangeStr = args.join(' ');
    const dateRangeMatch = dateRangeStr.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
    
    if (!dateRangeMatch) {
      return ctx.reply(
        `❌ Format ngày không đúng!\n\n` +
        `📝 Cú pháp: /transactions_with_date <từ_ngày> - <đến_ngày>\n\n` +
        `📅 Format ngày: DD/MM/YYYY\n` +
        `💡 Ví dụ: /transactions_with_date 22/1/2025 - 22/10/2025`
      );
    }
    
    const fromDateStr = dateRangeMatch[1];
    const toDateStr = dateRangeMatch[2];
    
    const fromDate = parseDate(fromDateStr);
    const toDate = parseDate(toDateStr);
    
    if (!fromDate || !toDate) {
      return ctx.reply('❌ Ngày không hợp lệ! Vui lòng sử dụng format DD/MM/YYYY');
    }
    
    if (fromDate > toDate) {
      return ctx.reply('❌ Ngày bắt đầu phải nhỏ hơn hoặc bằng ngày kết thúc!');
    }
    
    ctx.reply('⏳ Đang lấy lịch sử giao dịch từ API v1...');
    
    const accountNumber = MB_BANK_CARD_DEFAULT || '3999919072004';
    const transactions = await fetchTransactions(accountNumber);
    
    if (!transactions || transactions.length === 0) {
      return ctx.reply(`📭 Không có giao dịch nào\n💳 Tài khoản: ${accountNumber}`);
    }
    
    // Filter transactions by date range
    const filteredTransactions = transactions.filter(tx => 
      isTransactionInDateRange(tx, fromDate, toDate)
    );
    
    if (filteredTransactions.length === 0) {
      return ctx.reply(
        `📭 Không có giao dịch nào trong khoảng thời gian từ ${fromDateStr} đến ${toDateStr}\n` +
        `💳 Tài khoản: ${accountNumber}`
      );
    }
    
    let message = `📜 LỊCH SỬ GIAO DỊCH THEO NGÀY\n\n`;
    message += `💳 Tài khoản: ${accountNumber}\n`;
    message += `📅 Từ: ${fromDateStr} đến ${toDateStr}\n`;
    message += `📊 Tổng số giao dịch: ${filteredTransactions.length}\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n`;
    
    // Show all filtered transactions
    filteredTransactions.forEach((transaction, index) => {
      message += formatTransaction(transaction, index + 1);
      message += `\n`;
    });
    
    // Split message if too long (Telegram limit is 4096 characters)
    if (message.length > 4000) {
      // Split by newlines to avoid breaking transactions
      const lines = message.split('\n');
      let currentChunk = '';
      
      for (const line of lines) {
        if ((currentChunk + line + '\n').length > 4000) {
          if (currentChunk) {
            await ctx.reply(currentChunk.trim());
            currentChunk = '';
          }
        }
        currentChunk += line + '\n';
      }
      
      if (currentChunk.trim()) {
        await ctx.reply(currentChunk.trim());
      }
    } else {
      await ctx.reply(message);
    }
  } catch (error) {
    console.error('Transactions with date error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Transaction 1 Day command - Get transactions from yesterday to today
bot.command('transaction_1_day', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  try {
    // Calculate yesterday and today dates
    const now = new Date();
    const today = new Date(now);
    today.setHours(23, 59, 59, 999);
    
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    
    // Format dates for display
    const formatDateForDisplay = (date) => {
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      return `${day}/${month}/${year}`;
    };
    
    const fromDateStr = formatDateForDisplay(yesterday);
    const toDateStr = formatDateForDisplay(today);
    
    ctx.reply('⏳ Đang lấy giao dịch từ hôm qua đến hôm nay...');
    
    const accountNumber = MB_BANK_CARD_DEFAULT || '3999919072004';
    const transactions = await fetchTransactions(accountNumber);
    
    if (!transactions || transactions.length === 0) {
      return ctx.reply(`📭 Không có giao dịch nào\n💳 Tài khoản: ${accountNumber}`);
    }
    
    // Filter transactions by date range (yesterday to today)
    const filteredTransactions = transactions.filter(tx => 
      isTransactionInDateRange(tx, yesterday, today)
    );
    
    if (filteredTransactions.length === 0) {
      return ctx.reply(
        `📭 Không có giao dịch nào từ ${fromDateStr} đến ${toDateStr}\n` +
        `💳 Tài khoản: ${accountNumber}`
      );
    }
    
    let message = `📜 GIAO DỊCH TRONG 1 NGÀY\n\n`;
    message += `💳 Tài khoản: ${accountNumber}\n`;
    message += `📅 Từ: ${fromDateStr} đến ${toDateStr}\n`;
    message += `📊 Tổng số giao dịch: ${filteredTransactions.length}\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n`;
    
    // Show all filtered transactions
    filteredTransactions.forEach((transaction, index) => {
      message += formatTransaction(transaction, index + 1);
      message += `\n`;
    });
    
    // Split message if too long (Telegram limit is 4096 characters)
    if (message.length > 4000) {
      // Split by newlines to avoid breaking transactions
      const lines = message.split('\n');
      let currentChunk = '';
      
      for (const line of lines) {
        if ((currentChunk + line + '\n').length > 4000) {
          if (currentChunk) {
            await ctx.reply(currentChunk.trim());
            currentChunk = '';
          }
        }
        currentChunk += line + '\n';
      }
      
      if (currentChunk.trim()) {
        await ctx.reply(currentChunk.trim());
      }
    } else {
      await ctx.reply(message);
    }
  } catch (error) {
    console.error('Transaction 1 day error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Helper function to export transactions to Excel
const exportTransactionsToExcel = (transactions, filename) => {
  // Prepare data for Excel
  const excelData = transactions.map((tx, index) => {
    const isCredit = normalizeAmount(tx.creditAmount) > 0 || tx.type === 'IN';
    const creditAmount = normalizeAmount(tx.creditAmount);
    const debitAmount = normalizeAmount(tx.debitAmount);
    const transactionDate = tx.transactionDate && tx.transactionTime 
      ? `${tx.transactionDate} ${tx.transactionTime}`
      : tx.transactionDate || '';
    
    return {
      'STT': index + 1,
      'Ma Giao Dich': tx.transactionID || tx.transactionId || tx.tranId || tx.refNo || '',
      'So Tien Nhan': creditAmount > 0 ? creditAmount : '',
      'So Tien Chi': debitAmount > 0 ? debitAmount : '',
      'So Du Kha Dung': normalizeAmount(tx.availableBalance || tx.balanceAvailable),
      'Noi Dung CK': tx.transactionDesc || tx.description || '',
      'Ngay Giao Dich': transactionDate,
      'So Tai Khoan': tx.accountNo || '',
      'Loai': tx.type || (isCredit ? 'IN' : 'OUT'),
    };
  });

  // Create workbook and worksheet
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(excelData);

  // Set column widths
  const colWidths = [
    { wch: 5 },   // STT
    { wch: 20 },  // Ma Giao Dich
    { wch: 15 },  // So Tien Nhan
    { wch: 15 },  // So Tien Chi
    { wch: 18 },  // So Du Kha Dung
    { wch: 50 },  // Noi Dung CK
    { wch: 20 },  // Ngay Giao Dich
    { wch: 15 },  // So Tai Khoan
    { wch: 8 },   // Loai
  ];
  ws['!cols'] = colWidths;

  // Add worksheet to workbook
  XLSX.utils.book_append_sheet(wb, ws, 'Giao Dich');

  // Write to file
  const filePath = path.join(__dirname, filename);
  XLSX.writeFile(wb, filePath);

  return filePath;
};

// Export all transactions to Excel
bot.command('export_excel_transactions_all', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  try {
    const args = ctx.message.text.split(' ').slice(1);
    
    // Get account number: from argument or default from .env
    const accountNumber = args.length > 0 && args[0] 
      ? args[0] 
      : (MB_BANK_CARD_DEFAULT || '3999919072004');
    
    ctx.reply('⏳ Đang lấy lịch sử giao dịch và tạo file Excel...');
    
    const transactions = await fetchTransactions(accountNumber);
    
    if (!transactions || transactions.length === 0) {
      return ctx.reply(`📭 Không có giao dịch nào\n💳 Tài khoản: ${accountNumber}`);
    }
    
    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `transactions_all_${accountNumber}_${timestamp}.xlsx`;
    
    // Export to Excel
    const filePath = exportTransactionsToExcel(transactions, filename);
    
    // Send file to user
    await ctx.replyWithDocument({
      source: filePath,
      filename: filename
    }, {
      caption: `📊 File Excel đã được tạo thành công!\n\n` +
               `💳 Tài khoản: ${accountNumber}\n` +
               `📊 Tổng số giao dịch: ${transactions.length}\n` +
               `📅 Ngày tạo: ${new Date().toLocaleString('vi-VN')}`
    });
    
    // Clean up file after sending
    setTimeout(() => {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        console.error('Error deleting file:', error);
      }
    }, 5000);
    
  } catch (error) {
    console.error('Export Excel error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Export transactions with date range to Excel
bot.command('excel_transactions_with_date', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  try {
    const args = ctx.message.text.split(' ').slice(1);
    
    if (args.length < 3) {
      return ctx.reply(
        `❌ Sai cú pháp!\n\n` +
        `📝 Cú pháp: /excel_transactions_with_date <từ_ngày> - <đến_ngày>\n\n` +
        `📅 Format ngày: DD/MM/YYYY\n` +
        `💡 Ví dụ: /excel_transactions_with_date 22/1/2025 - 22/10/2025`
      );
    }
    
    // Parse date range: "22/1/2025 - 22/10/2025"
    const dateRangeStr = args.join(' ');
    const dateRangeMatch = dateRangeStr.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
    
    if (!dateRangeMatch) {
      return ctx.reply(
        `❌ Format ngày không đúng!\n\n` +
        `📝 Cú pháp: /excel_transactions_with_date <từ_ngày> - <đến_ngày>\n\n` +
        `📅 Format ngày: DD/MM/YYYY\n` +
        `💡 Ví dụ: /excel_transactions_with_date 22/1/2025 - 22/10/2025`
      );
    }
    
    const fromDateStr = dateRangeMatch[1];
    const toDateStr = dateRangeMatch[2];
    
    const fromDate = parseDate(fromDateStr);
    const toDate = parseDate(toDateStr);
    
    if (!fromDate || !toDate) {
      return ctx.reply('❌ Ngày không hợp lệ! Vui lòng sử dụng format DD/MM/YYYY');
    }
    
    if (fromDate > toDate) {
      return ctx.reply('❌ Ngày bắt đầu phải nhỏ hơn hoặc bằng ngày kết thúc!');
    }
    
    ctx.reply('⏳ Đang lấy lịch sử giao dịch và tạo file Excel...');
    
    const accountNumber = MB_BANK_CARD_DEFAULT || '3999919072004';
    const transactions = await fetchTransactions(accountNumber);
    
    if (!transactions || transactions.length === 0) {
      return ctx.reply(`📭 Không có giao dịch nào\n💳 Tài khoản: ${accountNumber}`);
    }
    
    // Filter transactions by date range
    const filteredTransactions = transactions.filter(tx => 
      isTransactionInDateRange(tx, fromDate, toDate)
    );
    
    if (filteredTransactions.length === 0) {
      return ctx.reply(
        `📭 Không có giao dịch nào trong khoảng thời gian từ ${fromDateStr} đến ${toDateStr}\n` +
        `💳 Tài khoản: ${accountNumber}`
      );
    }
    
    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dateRangeForFile = `${fromDateStr.replace(/\//g, '-')}_${toDateStr.replace(/\//g, '-')}`;
    const filename = `transactions_${dateRangeForFile}_${timestamp}.xlsx`;
    
    // Export to Excel
    const filePath = exportTransactionsToExcel(filteredTransactions, filename);
    
    // Send file to user
    await ctx.replyWithDocument({
      source: filePath,
      filename: filename
    }, {
      caption: `📊 File Excel đã được tạo thành công!\n\n` +
               `💳 Tài khoản: ${accountNumber}\n` +
               `📅 Từ: ${fromDateStr} đến ${toDateStr}\n` +
               `📊 Tổng số giao dịch: ${filteredTransactions.length}\n` +
               `📅 Ngày tạo: ${new Date().toLocaleString('vi-VN')}`
    });
    
    // Clean up file after sending
    setTimeout(() => {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        console.error('Error deleting file:', error);
      }
    }, 5000);
    
  } catch (error) {
    console.error('Export Excel with date error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Custom transactions command - Get transactions from API v1 (HIDDEN)
// bot.command('transactions_custom', async (ctx) => {
//   if (!requireAdmin(ctx)) return;
//   try {
//     const args = ctx.message.text.split(' ').slice(1);
//     
//     if (args.length < 1) {
//       return ctx.reply(
//         `❌ Sai cú pháp!\n\n` +
//         `📝 Cú pháp: /transactions_custom <số_tài_khoản>\n\n` +
//         `💡 Ví dụ: /transactions_custom 3999919072004\n\n` +
//         `ℹ️ Lưu ý: API v1 trả về tất cả giao dịch với đầy đủ thông tin.`
//       );
//     }
//     
//     const accountNumber = args[0];
//     
//     ctx.reply('⏳ Đang lấy lịch sử giao dịch từ API v1...');
//     
//     const transactions = await fetchTransactions(accountNumber);
//     
//     if (!transactions || transactions.length === 0) {
//       return ctx.reply(`📭 Không có giao dịch nào\n💳 Tài khoản: ${accountNumber}`);
//     }
//     
//     let message = `📜 LỊCH SỬ GIAO DỊCH (API v1)\n\n`;
//     message += `💳 Tài khoản: ${accountNumber}\n`;
//     message += `📊 Tổng số giao dịch: ${transactions.length}\n\n`;
//     message += `━━━━━━━━━━━━━━━━━━━━\n`;
//     
//     // Limit to 20 transactions per message
//     const transactionsToShow = transactions.slice(0, 20);
//     
//     transactionsToShow.forEach((transaction, index) => {
//       message += formatTransaction(transaction, index + 1);
//       message += `\n`;
//     });
//     
//     if (transactions.length > 20) {
//       message += `\n⚠️ Chỉ hiển thị 20 giao dịch đầu tiên. Tổng cộng có ${transactions.length} giao dịch.`;
//     }
//     
//     // Split message if too long
//     if (message.length > 4000) {
//       const chunks = message.match(/[\s\S]{1,4000}/g) || [];
//       for (const chunk of chunks) {
//         await ctx.reply(chunk);
//       }
//     } else {
//       ctx.reply(message);
//     }
//   } catch (error) {
//     console.error('Custom transactions error:', error);
//     ctx.reply(`❌ Lỗi: ${error.message}`);
//   }
// });

bot.command('addsubscriber', (ctx) => {
  if (!requireAdmin(ctx)) return;

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    ctx.reply('ℹ️ Cú pháp: /addsubscriber <chat_id>');
    return;
  }

  const chatId = args[0].trim();
  if (!chatId) {
    ctx.reply('❌ Chat ID không hợp lệ.');
    return;
  }

  const result = addSubscriber(chatId);
  if (result.reason === 'added') {
    ctx.reply(`✅ Đã thêm chat ID ${chatId} vào danh sách nhận thông báo.`);
  } else if (result.reason === 'exists') {
    ctx.reply(`ℹ️ Chat ID ${chatId} đã có trong danh sách nhận thông báo.`);
  } else {
    ctx.reply(`⚠️ Không thể thêm chat ID ${chatId}.`);
  }
});

bot.command('remsubscriber', (ctx) => {
  if (!requireAdmin(ctx)) return;

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    ctx.reply('ℹ️ Cú pháp: /remsubscriber <chat_id>');
    return;
  }

  const chatId = args[0].trim();
  if (!chatId) {
    ctx.reply('❌ Chat ID không hợp lệ.');
    return;
  }

  if (subscribedUsers.has(String(chatId))) {
    removeSubscriber(chatId, 'admin remove command');
    ctx.reply(`✅ Đã xoá chat ID ${chatId} khỏi danh sách nhận thông báo.`);
  } else {
    ctx.reply(`ℹ️ Chat ID ${chatId} không có trong danh sách nhận thông báo.`);
  }
});

bot.command('addsubscriber_me', (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    ctx.reply('❌ Không xác định được chat ID.');
    return;
  }

  const result = addSubscriber(String(chatId));
  if (result.reason === 'added') {
    ctx.reply(`✅ Đã thêm chat hiện tại (${chatId}) vào danh sách nhận thông báo.`);
  } else if (result.reason === 'exists') {
    ctx.reply(`ℹ️ Chat hiện tại (${chatId}) đã có trong danh sách nhận thông báo.`);
  } else {
    ctx.reply(`⚠️ Không thể thêm chat hiện tại (${chatId}).`);
  }
});

bot.command('get_chat_id', (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    ctx.reply('❌ Không xác định được chat ID.');
    return;
  }
  ctx.reply(`ℹ️ Chat ID hiện tại: ${chatId}`);
});

bot.command('add_new_admin', (ctx) => {
  if (!requireAdmin(ctx)) return;

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    ctx.reply('ℹ️ Cú pháp: /add_new_admin <chat_id>');
    return;
  }

  const adminId = args[0].trim();
  if (!adminId) {
    ctx.reply('❌ Chat ID không hợp lệ.');
    return;
  }

  const idStr = String(adminId);
  const addResult = addAdmin(adminId);
  if (addResult.reason === 'added') {
    ctx.reply(`✅ Đã thêm chat ID ${idStr} vào danh sách admin.`);
  } else if (addResult.reason === 'exists') {
    ctx.reply(`ℹ️ Chat ID ${idStr} đã là admin.`);
  } else {
    ctx.reply(`⚠️ Không thể thêm admin cho chat ID ${idStr}.`);
  }
});

bot.command('remove_admin_id', (ctx) => {
  if (!requireAdmin(ctx)) return;

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    ctx.reply('ℹ️ Cú pháp: /remove_admin_id <chat_id>');
    return;
  }

  const adminId = args[0].trim();
  if (!adminId) {
    ctx.reply('❌ Chat ID không hợp lệ.');
    return;
  }

  const removeResult = removeAdmin(adminId);
  if (removeResult.reason === 'removed') {
    // Optionally also remove from subscribers to avoid stale entries
    removeSubscriber(adminId, 'bị xoá khỏi danh sách admin');
    ctx.reply(`✅ Đã xoá chat ID ${adminId} khỏi danh sách admin.`);
  } else if (removeResult.reason === 'not_found') {
    ctx.reply(`ℹ️ Chat ID ${adminId} không nằm trong danh sách admin.`);
  } else {
    ctx.reply(`⚠️ Không thể xoá admin với chat ID ${adminId}.`);
  }
});

const buildHelpMessage = ({ isAdminUser = false } = {}) => {
  const commonLines = [
    '👋 Chào mừng đến với Bot Check Thông Báo Giao Dịch Tài Khoản Xịn',
    `💳 Thẻ Mặc Định: ${MB_BANK_CARD_DEFAULT}`,
    `🤖 Bot tự động kiểm tra giao dịch mỗi 1 phút`,
    '',
    '📋 Các lệnh dành cho User:',
    '/addsubscriber_me - Đăng ký nhận thông báo cho chính chat hiện tại',
    '/get_chat_id - Xem chat ID hiện tại',
    '/help - Hiển thị hướng dẫn',
    '',

  ];

  if (!isAdminUser) {
    commonLines.push('', '🛡️ Một số lệnh chỉ dành cho admin. Liên hệ admin nếu bạn cần hỗ trợ thêm.');
    return commonLines.join('\n');
  }

  const adminLines = [
    '',
    '🛡️ Lệnh dành cho Admin:',
    '/balance - Xem số dư từ giao dịch mới nhất',
    '/transactions [số_tài_khoản] - Xem tất cả lịch sử giao dịch',
    '/transaction_today - Xem giao dịch hôm nay',
    '/transaction_1_day - Xem giao dịch từ hôm qua đến hôm nay',
    '/transactions_with_date <từ_ngày> - <đến_ngày> - Xem lịch sử giao dịch theo khoảng ngày',
    '/find_transaction <transaction_id> - Tìm giao dịch theo ID',
    '/search_amount <số_tiền> - Tìm giao dịch theo số tiền',
    '/search_order <mã_đơn_hàng> - Tìm giao dịch theo mã đơn hàng',
    '/addsubscriber <chat_id> - Thêm chat ID User nhận thông báo',
    '/remsubscriber <chat_id> - Xoá chat ID User khỏi thông báo',
    '/add_new_admin <chat_id> - Thêm Admin mới',
    '/remove_admin_id <chat_id> - Xoá Admin khỏi bot',
    '/get_all_chat_id - Xem danh sách tất cả Chat ID đang đăng ký BOT',
    '',
    '💾 Lệnh Export Excel:',
    '/export_excel_transactions_all [số_tài_khoản] - Export tất cả giao dịch ra file Excel',
    '/excel_today - Export giao dịch hôm nay ra file Excel',
    '/excel_transactions_with_date <từ_ngày> - <đến_ngày> - Export giao dịch theo khoảng ngày ra file Excel',
    '',
    '⭐ Lệnh tiện ích:',
    '/test_payment <số_tiền> <transaction_id> - Giả lập giao dịch để test bot',
    '/test_checknotifiorder [chat_id] - Test gửi tin nhắn đến bot CheckNotifiOrder',
    '/set_default_card <số_thẻ> - Thay đổi thẻ mặc định',
    '/set_default_account_mb_bank username:<username> password:<password> - Thay đổi tài khoản MB Bank',
    '/reload_config - Reload file config mà không cần restart bot',
    '/check_cron_status - Kiểm tra cronjob có chạy đúng mỗi phút không',
    '/last_transactions - Trả về giao dịch gần nhất',
    '/bot_status - Xem trạng thái bot và cấu hình',
    '/logs - Xem logs và trạng thái hệ thống',
    '/reconnect_db - Reconnect đến MongoDB database',
    '/reconnect_server - Reconnect đến Telegram API server',
    '',
    '📱 Lệnh quản lý CheckNotifiOrder:',
    '/add_notifi_order <chat_id> - Thêm chat ID nhận thông báo đơn hàng từ CheckNotifiOrder',
    '/list_notifi_order - Xem danh sách chat ID nhận thông báo CheckNotifiOrder',
    '/remove_notifi_order <chat_id> - Xóa chat ID khỏi danh sách nhận thông báo CheckNotifiOrder',
    '/resend_notifications - Gửi lại tất cả đơn hàng chờ thông báo đến CheckNotifiOrder',
    '',
    '📊 Lệnh thống kê:',
    '/stats_today - Thống kê hôm nay (tổng tiền vào/ra)',
    '/stats_month <MM/YYYY> - Thống kê theo tháng',
  ];

  return [...commonLines, ...adminLines].join('\n');
};

bot.command('get_all_chat_id', (ctx) => {
  if (!requireAdmin(ctx)) return;

  const subscriberList = Array.from(subscribedUsers);
  const adminList = Array.from(adminUsers);

  if (subscriberList.length === 0 && adminList.length === 0) {
    ctx.reply('ℹ️ Chưa có chat ID nào đăng ký hoặc nằm trong danh sách admin.');
    return;
  }

  let message = '📋 Danh sách người nhận thông báo:\n';
  if (subscriberList.length > 0) {
    message += '\n👥 Subscribers:\n- ' + subscriberList.join('\n- ');
  }
  if (adminList.length > 0) {
    message += '\n\n🛡️ Admins:\n- ' + adminList.join('\n- ');
  }

  ctx.reply(message.trim());
});

// Function to update .env file
const updateEnvFile = (key, value) => {
  try {
    let envContent = '';
    if (fs.existsSync(CONFIG_FILE)) {
      envContent = fs.readFileSync(CONFIG_FILE, 'utf8');
    }
    
    const lines = envContent.split('\n');
    let found = false;
    const newLines = lines.map(line => {
      // Skip comments and empty lines
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('#') || trimmedLine === '') {
        return line;
      }
      
      // Match lines that start with key= (with optional spaces before =)
      if (trimmedLine.match(new RegExp(`^${key}\\s*=`))) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });
    
    if (!found) {
      // Add new line if not found, preserving existing newline at end
      if (newLines.length > 0 && newLines[newLines.length - 1] !== '') {
        newLines.push('');
      }
      newLines.push(`${key}=${value}`);
    }
    
    fs.writeFileSync(CONFIG_FILE, newLines.join('\n'), 'utf8');
    return true;
  } catch (error) {
    console.error(`❌ Lỗi khi cập nhật .env:`, error.message);
    return false;
  }
};

// Command: /testPayment - Simulate a transaction
bot.command('test_payment', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    const args = ctx.message.text.split(' ').slice(1);
    
    if (args.length < 2) {
      return ctx.reply(
        `❌ Sai cú pháp!\n\n` +
        `📝 Cú pháp: /test_payment <số_tiền> <transaction_id>\n\n` +
        `💡 Ví dụ: /test_payment 200000 10005`
      );
    }
    
    const amount = args[0];
    const transactionId = args[1];
    
    // Create a fake transaction
    const now = new Date();
    const date = formatDate(now);
    const time = now.toLocaleTimeString('vi-VN', { hour12: false });
    
    const fakeTransaction = {
      refNo: transactionId,
      transactionId: transactionId,
      tranId: transactionId,
      transactionID: transactionId,
      postingDate: '',
      transactionDate: date,
      transactionTime: time,
      accountNo: MB_BANK_CARD_DEFAULT,
      creditAmount: amount,
      debitAmount: '0',
      currency: 'VND',
      transactionCurrency: 'VND',
      description: `TEST PAYMENT - Giả lập giao dịch test. Số tiền: ${amount}`,
      transactionDesc: `TEST PAYMENT - Giả lập giao dịch test. Số tiền: ${amount}`,
      availableBalance: '0',
      balanceAvailable: '0',
      beneficiaryAccount: '',
      type: 'IN',
      amount: amount,
    };
    
    // Format and send notification
    const accountNumber = MB_BANK_CARD_DEFAULT;
    const message = formatTransactionNotification(fakeTransaction, accountNumber);
    
    // Prepare recipient list (include all subscribers + admins)
    const recipients = new Set([...subscribedUsers, ...adminUsers]);
    
    if (recipients.size === 0) {
      return ctx.reply('⚠️ Không có người dùng nào đăng ký nhận thông báo.');
    }
    
    // Send to all recipients
    let successCount = 0;
    let failCount = 0;
    
    for (const userId of recipients) {
      try {
        if (message.length > 4000) {
          const chunks = message.match(/[\s\S]{1,4000}/g) || [];
          for (const chunk of chunks) {
            await bot.telegram.sendMessage(userId, chunk);
          }
        } else {
          await bot.telegram.sendMessage(userId, message);
        }
        successCount++;
      } catch (error) {
        console.error(`❌ Không thể gửi tin nhắn đến user ${userId}:`, error.message);
        failCount++;
      }
    }
    
    ctx.reply(
      `✅ Đã giả lập giao dịch thành công!\n\n` +
      `💰 Số tiền: ${formatAmountForNotification(amount, 'VND')}\n` +
      `🆔 Transaction ID: ${transactionId}\n` +
      `📤 Đã gửi đến ${successCount} người dùng${failCount > 0 ? ` (${failCount} lỗi)` : ''}`
    );
  } catch (error) {
    console.error('Test payment error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /test_checknotifiorder - Test sending message to CheckNotifiOrder bot
bot.command('test_checknotifiorder', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    const args = ctx.message.text.split(' ').slice(1);
    const chatId = args.length > 0 ? args[0].trim() : null;
    
    if (!CHECK_NOTIFI_ORDER_BOT_TOKEN) {
      return ctx.reply(
        '❌ Chưa cấu hình CHECK_NOTIFI_ORDER_BOT_TOKEN trong file .env'
      );
    }
    
    const targetChatId = chatId || CHECK_NOTIFI_ORDER_CHAT_ID;
    
    if (!targetChatId) {
      return ctx.reply(
        '❌ Chưa cấu hình CHECK_NOTIFI_ORDER_CHAT_ID!\n\n' +
        '💡 Cách lấy Chat ID:\n' +
        '1. Gửi /start cho bot CheckNotifiOrder\n' +
        '2. Bot sẽ hiển thị Chat ID\n' +
        '3. Thêm vào .env: CHECK_NOTIFI_ORDER_CHAT_ID=<chat_id>\n\n' +
        'Hoặc sử dụng: /test_checknotifiorder <chat_id>'
      );
    }
    
    ctx.reply('⏳ Đang gửi tin nhắn test đến bot CheckNotifiOrder...');
    
    // Create a test message
    const testMessage = `*🧪 TEST MESSAGE*\n\n` +
      `Đây là tin nhắn test từ BotCheckPayment\n\n` +
      `📅 Thời gian: ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}\n` +
      `🆔 Chat ID: ${targetChatId}\n` +
      `✅ Nếu bạn nhận được tin nhắn này, kết nối đã thành công!`;
    
    const result = await sendToCheckNotifiOrder(testMessage, targetChatId);
    
    if (result) {
      ctx.reply(
        `✅ Đã gửi tin nhắn test thành công!\n\n` +
        `📱 Chat ID: ${targetChatId}\n` +
        `🤖 Bot: CheckNotifiOrder\n\n` +
        `💡 Kiểm tra bot CheckNotifiOrder để xem tin nhắn.`
      );
    } else {
      ctx.reply(
        `❌ Không thể gửi tin nhắn đến bot CheckNotifiOrder!\n\n` +
        `📱 Chat ID: ${targetChatId}\n` +
        `💡 Kiểm tra:\n` +
        `• CHECK_NOTIFI_ORDER_BOT_TOKEN có đúng không?\n` +
        `• CHECK_NOTIFI_ORDER_CHAT_ID có đúng không?\n` +
        `• Bot CheckNotifiOrder có đang chạy không?`
      );
    }
  } catch (error) {
    console.error('Test checkNotifiOrder error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /setDefaultCard - Change default card
bot.command('set_default_card', (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    const args = ctx.message.text.split(' ').slice(1);
    
    if (args.length === 0) {
      return ctx.reply(
        `❌ Sai cú pháp!\n\n` +
        `📝 Cú pháp: /set_default_card <số_thẻ>\n\n` +
        `💡 Ví dụ: /set_default_card 3999919072004`
      );
    }
    
    const cardNumber = args[0].trim();
    
    if (!cardNumber || cardNumber.length < 10) {
      return ctx.reply('❌ Số thẻ không hợp lệ!');
    }
    
    // Update runtime variable
    MB_BANK_CARD_DEFAULT = cardNumber;
    
    // Update .env file
    const updated = updateEnvFile('MB_BANK_CARD_DEFAULT', cardNumber);
    
    if (updated) {
      ctx.reply(`✅ Đã cập nhật thẻ mặc định thành công!\n\n💳 Số thẻ mới: ${cardNumber}`);
    } else {
      ctx.reply(`⚠️ Đã cập nhật thẻ mặc định trong bộ nhớ, nhưng không thể cập nhật file .env.\n\n💳 Số thẻ mới: ${cardNumber}`);
    }
  } catch (error) {
    console.error('Set default card error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /setDefaultAccountMBBank - Set default MBBank account
bot.command('set_default_account_mb_bank', (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    const args = ctx.message.text.split(' ').slice(1);
    
    if (args.length === 0) {
      return ctx.reply(
        `❌ Sai cú pháp!\n\n` +
        `📝 Cú pháp: /set_default_account_mb_bank username:<username> password:<password>\n\n` +
        `💡 Ví dụ: /set_default_account_mb_bank username:0842366570 password:Tra_190704`
      );
    }
    
    const input = args.join(' ');
    const usernameMatch = input.match(/username:([^\s]+)/i);
    const passwordMatch = input.match(/password:([^\s]+)/i);
    
    if (!usernameMatch || !passwordMatch) {
      return ctx.reply(
        `❌ Sai cú pháp!\n\n` +
        `📝 Cú pháp: /set_default_account_mb_bank username:<username> password:<password>\n\n` +
        `💡 Ví dụ: /set_default_account_mb_bank username:0842366570 password:Tra_190704`
      );
    }
    
    const username = usernameMatch[1];
    const password = passwordMatch[1];
    
    // Update runtime variables
    MB_USERNAME = username;
    MB_PASSWORD = password;
    
    // Update .env file
    const usernameUpdated = updateEnvFile('MB_USERNAME', username);
    const passwordUpdated = updateEnvFile('MB_PASSWORD', password);
    
    if (usernameUpdated && passwordUpdated) {
      ctx.reply(
        `✅ Đã cập nhật tài khoản MB Bank thành công!\n\n` +
        `👤 Username: ${username}\n` +
        `🔒 Password: ${'*'.repeat(password.length)}`
      );
    } else {
      ctx.reply(
        `⚠️ Đã cập nhật tài khoản trong bộ nhớ, nhưng không thể cập nhật file .env.\n\n` +
        `👤 Username: ${username}\n` +
        `🔒 Password: ${'*'.repeat(password.length)}`
      );
    }
  } catch (error) {
    console.error('Set default account error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /switch_api_apicanhan - Switch to API Canhan
bot.command('switch_api_apicanhan', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    if (currentApiMethod === 'apicanhan') {
      return ctx.reply(
        `ℹ️ Đang sử dụng phương thức: API Canhan\n\n` +
        `Không cần chuyển đổi.`
      );
    }
    
    // Test the new method before switching
    ctx.reply(`⏳ Đang kiểm tra API Canhan...`);
    
    const accountNumber = MB_BANK_CARD_DEFAULT || '3999919072004';
    let testTransactions = [];
    
    try {
      testTransactions = await fetchTransactionsApicanhan(accountNumber);
      
      // Save the new method
      const saved = saveApiMethod('apicanhan');
      
      if (saved) {
        ctx.reply(
          `✅ Đã chuyển sang phương thức API: API Canhan\n\n` +
          `📊 Tìm thấy ${testTransactions.length} giao dịch trong lần kiểm tra.\n\n` +
          `🔄 Bot sẽ sử dụng phương thức này cho các lần kiểm tra tiếp theo.`
        );
      } else {
        ctx.reply(`❌ Không thể lưu phương thức API mới.`);
      }
    } catch (testError) {
      ctx.reply(
        `❌ Không thể kết nối với API Canhan:\n\n` +
        `${testError.message}\n\n` +
        `⚠️ Giữ nguyên phương thức hiện tại: MB Bank Library`
      );
    }
  } catch (error) {
    console.error('Switch API method error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /switch_api_mbbank - Switch to MB Bank Library
bot.command('switch_api_mbbank', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    if (currentApiMethod === 'mbbank') {
      return ctx.reply(
        `ℹ️ Đang sử dụng phương thức: MB Bank Library\n\n` +
        `Không cần chuyển đổi.`
      );
    }
    
    // Test the new method before switching
    ctx.reply(`⏳ Đang kiểm tra MB Bank Library...`);
    
    const accountNumber = MB_BANK_CARD_DEFAULT || '3999919072004';
    let testTransactions = [];
    
    try {
      testTransactions = await fetchTransactionsV3(accountNumber);
      
      // Save the new method
      const saved = saveApiMethod('mbbank');
      
      if (saved) {
        ctx.reply(
          `✅ Đã chuyển sang phương thức API: MB Bank Library\n\n` +
          `📊 Tìm thấy ${testTransactions.length} giao dịch trong lần kiểm tra.\n\n` +
          `🔄 Bot sẽ sử dụng phương thức này cho các lần kiểm tra tiếp theo.`
        );
      } else {
        ctx.reply(`❌ Không thể lưu phương thức API mới.`);
      }
    } catch (testError) {
      ctx.reply(
        `❌ Không thể kết nối với MB Bank Library:\n\n` +
        `${testError.message}\n\n` +
        `⚠️ Giữ nguyên phương thức hiện tại: API Canhan`
      );
    }
  } catch (error) {
    console.error('Switch API method error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /switch_apicanhan_test - Test API Canhan without switching
bot.command('switch_apicanhan_test', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    ctx.reply(`⏳ Đang test API Canhan (không thay đổi phương thức hiện tại)...`);
    
    const accountNumber = MB_BANK_CARD_DEFAULT || '3999919072004';
    
    try {
      const testTransactions = await fetchTransactionsApicanhan(accountNumber);
      
      // Format transaction details for display
      let message = `✅ TEST API CANHAN THÀNH CÔNG\n\n`;
      message += `📊 Tìm thấy ${testTransactions.length} giao dịch\n\n`;
      message += `🔧 Phương thức hiện tại: ${currentApiMethod === 'mbbank' ? 'MB Bank Library' : 'API Canhan'}\n`;
      message += `ℹ️ Phương thức hiện tại KHÔNG bị thay đổi\n\n`;
      
      if (testTransactions.length > 0) {
        message += `📋 GIAO DỊCH MỚI NHẤT:\n`;
        message += `━━━━━━━━━━━━━━━━━━━━\n`;
        const latest = testTransactions[0];
        message += `🆔 Transaction ID: ${latest.transactionID || latest.transactionId || 'N/A'}\n`;
        message += `📅 Ngày: ${latest.transactionDate || 'N/A'} ${latest.transactionTime || ''}\n`;
        message += `💰 Số tiền: ${latest.creditAmount || '0'} VND\n`;
        message += `📝 Nội dung: ${latest.description || 'N/A'}\n`;
        message += `💳 Số dư: ${latest.availableBalance || '0'} VND\n`;
        
        if (testTransactions.length > 1) {
          message += `\n... và ${testTransactions.length - 1} giao dịch khác`;
        }
      }
      
      message += `\n\n💡 Để chuyển sang API Canhan, dùng lệnh:\n`;
      message += `/switch_api_apicanhan`;
      
      ctx.reply(message);
    } catch (testError) {
      ctx.reply(
        `❌ TEST API CANHAN THẤT BẠI\n\n` +
        `📋 Chi tiết lỗi:\n` +
        `${testError.message}\n\n` +
        `🔧 Phương thức hiện tại: ${currentApiMethod === 'mbbank' ? 'MB Bank Library' : 'API Canhan'}\n` +
        `ℹ️ Phương thức hiện tại KHÔNG bị thay đổi`
      );
    }
  } catch (error) {
    console.error('Test API Canhan error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /reloadConfig - Reload config from .env
bot.command('reload_config', (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    // Reload .env file
    dotenv.config();
    
    // Update runtime variables
    MB_USERNAME = process.env.MB_USERNAME || '';
    MB_PASSWORD = process.env.MB_PASSWORD || '';
    
    // Use 3999919072004 as default if not set or if it's the old default value
    const envCardDefault = process.env.MB_BANK_CARD_DEFAULT;
    if (!envCardDefault || envCardDefault === '0842366570') {
      MB_BANK_CARD_DEFAULT = '3999919072004';
      // Update .env file if it has the old value
      if (envCardDefault === '0842366570') {
        updateEnvFile('MB_BANK_CARD_DEFAULT', '3999919072004');
      }
    } else {
      MB_BANK_CARD_DEFAULT = envCardDefault;
    }
    
    ctx.reply(
      `✅ Đã reload config thành công!\n\n` +
      `💳 Thẻ mặc định: ${MB_BANK_CARD_DEFAULT}\n` +
      `👤 Username: ${MB_USERNAME || '(chưa cấu hình)'}\n` +
      `🔒 Password: ${MB_PASSWORD ? '*'.repeat(MB_PASSWORD.length) : '(chưa cấu hình)'}`
    );
  } catch (error) {
    console.error('Reload config error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /checkCronStatus - Check cron job status
bot.command('check_cron_status', (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    const now = new Date();
    const nowFormatted = now.toLocaleTimeString('vi-VN', { 
      timeZone: 'Asia/Ho_Chi_Minh',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    
    if (lastCronCheckTime) {
      const lastCheck = new Date(lastCronCheckTime);
      const lastCheckFormatted = lastCheck.toLocaleTimeString('vi-VN', { 
        timeZone: 'Asia/Ho_Chi_Minh',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      const timeDiff = Math.floor((Date.now() - lastCronCheckTime) / 1000);
      
      let statusMessage = '⏱ Cron vẫn hoạt động!\n';
      statusMessage += `Lần cuối check: ${lastCheckFormatted}`;
      
      if (timeDiff > 120) {
        statusMessage += `\n\n⚠️ Cảnh báo: Đã ${timeDiff} giây kể từ lần check cuối (quá 2 phút)`;
      }
      
      ctx.reply(statusMessage);
    } else {
      ctx.reply(
        `⏱ Cron đang chạy nhưng chưa có lần check nào.\n` +
        `Thời gian hiện tại: ${nowFormatted}`
      );
    }
  } catch (error) {
    console.error('Check cron status error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /lastTransactions - Show last transaction
bot.command('last_transactions', (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    const lastTransaction = loadLastTransaction(true);
    
    if (!lastTransaction) {
      return ctx.reply('📭 Chưa có giao dịch nào được lưu.');
    }
    
    const accountNumber = MB_BANK_CARD_DEFAULT;
    const message = formatTransactionNotification(lastTransaction, accountNumber);
    
    // Add additional info
    const transactionId = getTransactionId(lastTransaction);
    const additionalInfo = `\n\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📋 Thông tin chi tiết:\n` +
      `🆔 Transaction ID: ${transactionId}\n` +
      `💳 Tài khoản: ${accountNumber}\n` +
      `📅 Ngày: ${lastTransaction.transactionDate || 'N/A'}\n` +
      `⏰ Giờ: ${lastTransaction.transactionTime || 'N/A'}\n` +
      `💰 Số tiền: ${formatAmountForNotification(lastTransaction.amount || lastTransaction.creditAmount || lastTransaction.debitAmount, 'VND')}\n` +
      `📊 Loại: ${lastTransaction.type || (normalizeAmount(lastTransaction.creditAmount) > 0 ? 'IN' : 'OUT')}`;
    
    const fullMessage = message + additionalInfo;
    
    if (fullMessage.length > 4000) {
      const chunks = fullMessage.match(/[\s\S]{1,4000}/g) || [];
      for (const chunk of chunks) {
        ctx.reply(chunk);
      }
    } else {
      ctx.reply(fullMessage);
    }
  } catch (error) {
    console.error('Last transactions error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /transaction_today - View transactions today only
bot.command('transaction_today', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  try {
    // Calculate today's date range
    const now = new Date();
    const today = new Date(now);
    today.setHours(23, 59, 59, 999);
    
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    
    // Format date for display
    const formatDateForDisplay = (date) => {
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      return `${day}/${month}/${year}`;
    };
    
    const todayStr = formatDateForDisplay(today);
    
    ctx.reply('⏳ Đang lấy giao dịch hôm nay...');
    
    const accountNumber = MB_BANK_CARD_DEFAULT || '3999919072004';
    const transactions = await fetchTransactions(accountNumber);
    
    if (!transactions || transactions.length === 0) {
      return ctx.reply(`📭 Không có giao dịch nào\n💳 Tài khoản: ${accountNumber}`);
    }
    
    // Filter transactions for today only
    const filteredTransactions = transactions.filter(tx => 
      isTransactionInDateRange(tx, todayStart, today)
    );
    
    if (filteredTransactions.length === 0) {
      return ctx.reply(
        `📭 Không có giao dịch nào hôm nay (${todayStr})\n` +
        `💳 Tài khoản: ${accountNumber}`
      );
    }
    
    let message = `📜 GIAO DỊCH HÔM NAY\n\n`;
    message += `💳 Tài khoản: ${accountNumber}\n`;
    message += `📅 Ngày: ${todayStr}\n`;
    message += `📊 Tổng số giao dịch: ${filteredTransactions.length}\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    // Show all filtered transactions
    filteredTransactions.forEach((transaction, index) => {
      message += formatTransaction(transaction, index + 1);
      message += `\n`;
      // Add separator between transactions (except for the last one)
      if (index < filteredTransactions.length - 1) {
        message += `\n`;
      }
    });
    
    // Split message if too long
    if (message.length > 4000) {
      const lines = message.split('\n');
      let currentChunk = '';
      
      for (const line of lines) {
        if ((currentChunk + line + '\n').length > 4000) {
          if (currentChunk) {
            await ctx.reply(currentChunk.trim());
            currentChunk = '';
          }
        }
        currentChunk += line + '\n';
      }
      
      if (currentChunk.trim()) {
        await ctx.reply(currentChunk.trim());
      }
    } else {
      await ctx.reply(message);
    }
  } catch (error) {
    console.error('Transaction today error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /find_transaction - Find transaction by ID
bot.command('find_transaction', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    const args = ctx.message.text.split(' ').slice(1);
    
    if (args.length === 0) {
      return ctx.reply(
        `❌ Sai cú pháp!\n\n` +
        `📝 Cú pháp: /find_transaction <transaction_id>\n\n` +
        `💡 Ví dụ: /find_transaction FT25318979950801`
      );
    }
    
    const searchId = args[0].trim();
    
    ctx.reply('⏳ Đang tìm kiếm giao dịch...');
    
    const accountNumber = MB_BANK_CARD_DEFAULT || '3999919072004';
    const transactions = await fetchTransactions(accountNumber);
    
    if (!transactions || transactions.length === 0) {
      return ctx.reply(`📭 Không có giao dịch nào\n💳 Tài khoản: ${accountNumber}`);
    }
    
    // Search for transaction by ID (case insensitive)
    const foundTransaction = transactions.find(tx => {
      const txId = getTransactionId(tx);
      return txId && txId.toLowerCase().includes(searchId.toLowerCase());
    });
    
    if (!foundTransaction) {
      return ctx.reply(
        `📭 Không tìm thấy giao dịch với ID: ${searchId}\n` +
        `💳 Tài khoản: ${accountNumber}`
      );
    }
    
    const accountNum = MB_BANK_CARD_DEFAULT;
    const message = formatTransactionNotification(foundTransaction, accountNum);
    
    const transactionId = getTransactionId(foundTransaction);
    const additionalInfo = `\n\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📋 Thông tin chi tiết:\n` +
      `🆔 Transaction ID: ${transactionId}\n` +
      `💳 Tài khoản: ${accountNum}\n` +
      `📅 Ngày: ${foundTransaction.transactionDate || 'N/A'}\n` +
      `⏰ Giờ: ${foundTransaction.transactionTime || 'N/A'}\n` +
      `💰 Số tiền: ${formatAmountForNotification(foundTransaction.amount || foundTransaction.creditAmount || foundTransaction.debitAmount, 'VND')}\n` +
      `📊 Loại: ${foundTransaction.type || (normalizeAmount(foundTransaction.creditAmount) > 0 ? 'IN' : 'OUT')}`;
    
    const fullMessage = message + additionalInfo;
    
    if (fullMessage.length > 4000) {
      const chunks = fullMessage.match(/[\s\S]{1,4000}/g) || [];
      for (const chunk of chunks) {
        ctx.reply(chunk);
      }
    } else {
      ctx.reply(fullMessage);
    }
  } catch (error) {
    console.error('Find transaction error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /stats_today - Statistics for today
bot.command('stats_today', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    // Calculate today's date range
    const now = new Date();
    const today = new Date(now);
    today.setHours(23, 59, 59, 999);
    
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    
    const formatDateForDisplay = (date) => {
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      return `${day}/${month}/${year}`;
    };
    
    const todayStr = formatDateForDisplay(today);
    
    ctx.reply('⏳ Đang tính toán thống kê hôm nay...');
    
    const accountNumber = MB_BANK_CARD_DEFAULT || '3999919072004';
    const transactions = await fetchTransactions(accountNumber);
    
    if (!transactions || transactions.length === 0) {
      return ctx.reply(`📭 Không có giao dịch nào\n💳 Tài khoản: ${accountNumber}`);
    }
    
    // Filter transactions for today
    const todayTransactions = transactions.filter(tx => 
      isTransactionInDateRange(tx, todayStart, today)
    );
    
    if (todayTransactions.length === 0) {
      return ctx.reply(
        `📭 Không có giao dịch nào hôm nay (${todayStr})\n` +
        `💳 Tài khoản: ${accountNumber}`
      );
    }
    
    // Calculate statistics
    let totalIn = 0;
    let totalOut = 0;
    let countIn = 0;
    let countOut = 0;
    
    todayTransactions.forEach(tx => {
      const isCredit = normalizeAmount(tx.creditAmount) > 0 || tx.type === 'IN';
      const amount = normalizeAmount(tx.amount || tx.creditAmount || tx.debitAmount);
      
      if (isCredit) {
        totalIn += amount;
        countIn++;
      } else {
        totalOut += amount;
        countOut++;
      }
    });
    
    const netAmount = totalIn - totalOut;
    
    let message = `📊 THỐNG KÊ HÔM NAY\n\n`;
    message += `💳 Tài khoản: ${accountNumber}\n`;
    message += `📅 Ngày: ${todayStr}\n`;
    message += `📊 Tổng số giao dịch: ${todayTransactions.length}\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `💰 Tiền vào:\n`;
    message += `   • Số lượng: ${countIn} giao dịch\n`;
    message += `   • Tổng tiền: ${formatCurrency(totalIn, 'VND')}\n\n`;
    message += `💸 Tiền ra:\n`;
    message += `   • Số lượng: ${countOut} giao dịch\n`;
    message += `   • Tổng tiền: ${formatCurrency(totalOut, 'VND')}\n\n`;
    message += `📈 Tổng kết:\n`;
    message += `   • Chênh lệch: ${formatCurrency(netAmount, 'VND')} ${netAmount >= 0 ? '💰' : '💸'}\n`;
    
    ctx.reply(message);
  } catch (error) {
    console.error('Stats today error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /stats_month - Statistics for a month
bot.command('stats_month', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    const args = ctx.message.text.split(' ').slice(1);
    
    if (args.length === 0) {
      return ctx.reply(
        `❌ Sai cú pháp!\n\n` +
        `📝 Cú pháp: /stats_month <MM/YYYY>\n\n` +
        `💡 Ví dụ: /stats_month 11/2025`
      );
    }
    
    const monthYearStr = args[0].trim();
    const monthYearMatch = monthYearStr.match(/^(\d{1,2})\/(\d{4})$/);
    
    if (!monthYearMatch) {
      return ctx.reply(
        `❌ Format không đúng!\n\n` +
        `📝 Cú pháp: /stats_month <MM/YYYY>\n\n` +
        `💡 Ví dụ: /stats_month 11/2025`
      );
    }
    
    const month = parseInt(monthYearMatch[1], 10);
    const year = parseInt(monthYearMatch[2], 10);
    
    if (month < 1 || month > 12) {
      return ctx.reply('❌ Tháng không hợp lệ! Tháng phải từ 1 đến 12.');
    }
    
    // Calculate month date range
    const monthStart = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);
    
    ctx.reply('⏳ Đang tính toán thống kê tháng...');
    
    const accountNumber = MB_BANK_CARD_DEFAULT || '3999919072004';
    const transactions = await fetchTransactions(accountNumber);
    
    if (!transactions || transactions.length === 0) {
      return ctx.reply(`📭 Không có giao dịch nào\n💳 Tài khoản: ${accountNumber}`);
    }
    
    // Filter transactions for the month
    const monthTransactions = transactions.filter(tx => 
      isTransactionInDateRange(tx, monthStart, monthEnd)
    );
    
    if (monthTransactions.length === 0) {
      return ctx.reply(
        `📭 Không có giao dịch nào trong tháng ${month}/${year}\n` +
        `💳 Tài khoản: ${accountNumber}`
      );
    }
    
    // Calculate statistics
    let totalIn = 0;
    let totalOut = 0;
    let countIn = 0;
    let countOut = 0;
    
    monthTransactions.forEach(tx => {
      const isCredit = normalizeAmount(tx.creditAmount) > 0 || tx.type === 'IN';
      const amount = normalizeAmount(tx.amount || tx.creditAmount || tx.debitAmount);
      
      if (isCredit) {
        totalIn += amount;
        countIn++;
      } else {
        totalOut += amount;
        countOut++;
      }
    });
    
    const netAmount = totalIn - totalOut;
    
    let message = `📊 THỐNG KÊ THÁNG\n\n`;
    message += `💳 Tài khoản: ${accountNumber}\n`;
    message += `📅 Tháng: ${month}/${year}\n`;
    message += `📊 Tổng số giao dịch: ${monthTransactions.length}\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `💰 Tiền vào:\n`;
    message += `   • Số lượng: ${countIn} giao dịch\n`;
    message += `   • Tổng tiền: ${formatCurrency(totalIn, 'VND')}\n\n`;
    message += `💸 Tiền ra:\n`;
    message += `   • Số lượng: ${countOut} giao dịch\n`;
    message += `   • Tổng tiền: ${formatCurrency(totalOut, 'VND')}\n\n`;
    message += `📈 Tổng kết:\n`;
    message += `   • Chênh lệch: ${formatCurrency(netAmount, 'VND')} ${netAmount >= 0 ? '💰' : '💸'}\n`;
    
    ctx.reply(message);
  } catch (error) {
    console.error('Stats month error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /excel_today - Export today's transactions to Excel
bot.command('excel_today', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    // Calculate today's date range
    const now = new Date();
    const today = new Date(now);
    today.setHours(23, 59, 59, 999);
    
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    
    const formatDateForDisplay = (date) => {
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      return `${day}/${month}/${year}`;
    };
    
    const todayStr = formatDateForDisplay(today);
    
    ctx.reply('⏳ Đang lấy giao dịch hôm nay và tạo file Excel...');
    
    const accountNumber = MB_BANK_CARD_DEFAULT || '3999919072004';
    const transactions = await fetchTransactions(accountNumber);
    
    if (!transactions || transactions.length === 0) {
      return ctx.reply(`📭 Không có giao dịch nào\n💳 Tài khoản: ${accountNumber}`);
    }
    
    // Filter transactions for today
    const todayTransactions = transactions.filter(tx => 
      isTransactionInDateRange(tx, todayStart, today)
    );
    
    if (todayTransactions.length === 0) {
      return ctx.reply(
        `📭 Không có giao dịch nào hôm nay (${todayStr})\n` +
        `💳 Tài khoản: ${accountNumber}`
      );
    }
    
    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `transactions_today_${todayStr.replace(/\//g, '-')}_${timestamp}.xlsx`;
    
    // Export to Excel
    const filePath = exportTransactionsToExcel(todayTransactions, filename);
    
    // Send file to user
    await ctx.replyWithDocument({
      source: filePath,
      filename: filename
    }, {
      caption: `📊 File Excel đã được tạo thành công!\n\n` +
               `💳 Tài khoản: ${accountNumber}\n` +
               `📅 Ngày: ${todayStr}\n` +
               `📊 Tổng số giao dịch: ${todayTransactions.length}\n` +
               `📅 Ngày tạo: ${new Date().toLocaleString('vi-VN')}`
    });
    
    // Clean up file after sending
    setTimeout(() => {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        console.error('Error deleting file:', error);
      }
    }, 5000);
    
  } catch (error) {
    console.error('Excel today error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /bot_status - View bot status and configuration
bot.command('bot_status', (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    const subscriberCount = subscribedUsers.size;
    const adminCount = adminUsers.size;
    const lastTx = loadLastTransaction(true);
    
    let message = `🤖 TRẠNG THÁI BOT\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📋 Thông tin cấu hình:\n`;
    message += `💳 Thẻ mặc định: ${MB_BANK_CARD_DEFAULT}\n`;
    message += `👤 Username: ${MB_USERNAME || '(chưa cấu hình)'}\n`;
    message += `🔒 Password: ${MB_PASSWORD ? '*'.repeat(MB_PASSWORD.length) : '(chưa cấu hình)'}\n`;
    message += `🔑 API Key: ${MB_API_KEY ? MB_API_KEY.substring(0, 10) + '...' : '(chưa cấu hình)'}\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `👥 Thống kê người dùng:\n`;
    message += `   • Subscribers: ${subscriberCount}\n`;
    message += `   • Admins: ${adminCount}\n`;
    message += `   • Tổng: ${subscriberCount + adminCount}\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `⏰ Trạng thái Cron:\n`;
    
    if (lastCronCheckTime) {
      const lastCheck = new Date(lastCronCheckTime);
      const lastCheckFormatted = lastCheck.toLocaleTimeString('vi-VN', { 
        timeZone: 'Asia/Ho_Chi_Minh',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      const timeDiff = Math.floor((Date.now() - lastCronCheckTime) / 1000);
      message += `   • Lần cuối check: ${lastCheckFormatted}\n`;
      message += `   • Cách đây: ${timeDiff} giây\n`;
      if (timeDiff > 120) {
        message += `   • ⚠️ Cảnh báo: Quá 2 phút\n`;
      } else {
        message += `   • ✅ Hoạt động bình thường\n`;
      }
    } else {
      message += `   • Chưa có lần check nào\n`;
    }
    
    message += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📊 Giao dịch:\n`;
    
    if (lastTx) {
      const txId = getTransactionId(lastTx);
      const txDate = lastTx.transactionDate || 'N/A';
      const txTime = lastTx.transactionTime || 'N/A';
      message += `   • Giao dịch cuối: ${txId}\n`;
      message += `   • Ngày: ${txDate} ${txTime}\n`;
    } else {
      message += `   • Chưa có giao dịch nào được lưu\n`;
    }
    
    message += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `🕐 Thời gian hiện tại:\n`;
    message += `   • ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`;
    
    ctx.reply(message);
  } catch (error) {
    console.error('Bot status error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /search_amount - Search transactions by amount
bot.command('search_amount', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    const args = ctx.message.text.split(' ').slice(1);
    
    if (args.length === 0) {
      return ctx.reply(
        `❌ Sai cú pháp!\n\n` +
        `📝 Cú pháp: /search_amount <số_tiền>\n\n` +
        `💡 Ví dụ: /search_amount 200000`
      );
    }
    
    const searchAmount = normalizeAmount(args[0]);
    
    if (searchAmount <= 0) {
      return ctx.reply('❌ Số tiền phải lớn hơn 0!');
    }
    
    ctx.reply('⏳ Đang tìm kiếm giao dịch...');
    
    const accountNumber = MB_BANK_CARD_DEFAULT || '3999919072004';
    const transactions = await fetchTransactions(accountNumber);
    
    if (!transactions || transactions.length === 0) {
      return ctx.reply(`📭 Không có giao dịch nào\n💳 Tài khoản: ${accountNumber}`);
    }
    
    // Search for transactions with matching amount (allow small difference for rounding)
    const foundTransactions = transactions.filter(tx => {
      const txAmount = normalizeAmount(tx.amount || tx.creditAmount || tx.debitAmount);
      return Math.abs(txAmount - searchAmount) < 1; // Allow 1 VND difference
    });
    
    if (foundTransactions.length === 0) {
      return ctx.reply(
        `📭 Không tìm thấy giao dịch nào với số tiền: ${formatCurrency(searchAmount, 'VND')}\n` +
        `💳 Tài khoản: ${accountNumber}`
      );
    }
    
    let message = `🔍 KẾT QUẢ TÌM KIẾM\n\n`;
    message += `💰 Số tiền tìm kiếm: ${formatCurrency(searchAmount, 'VND')}\n`;
    message += `💳 Tài khoản: ${accountNumber}\n`;
    message += `📊 Tìm thấy: ${foundTransactions.length} giao dịch\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n`;
    
    // Show all found transactions
    foundTransactions.forEach((transaction, index) => {
      message += formatTransaction(transaction, index + 1);
      message += `\n`;
    });
    
    // Split message if too long
    if (message.length > 4000) {
      const lines = message.split('\n');
      let currentChunk = '';
      
      for (const line of lines) {
        if ((currentChunk + line + '\n').length > 4000) {
          if (currentChunk) {
            await ctx.reply(currentChunk.trim());
            currentChunk = '';
          }
        }
        currentChunk += line + '\n';
      }
      
      if (currentChunk.trim()) {
        await ctx.reply(currentChunk.trim());
      }
    } else {
      await ctx.reply(message);
    }
  } catch (error) {
    console.error('Search amount error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /search_order - Search transactions by order ID
bot.command('search_order', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    const args = ctx.message.text.split(' ').slice(1);
    
    if (args.length === 0) {
      return ctx.reply(
        `❌ Sai cú pháp!\n\n` +
        `📝 Cú pháp: /search_order <mã_đơn_hàng>\n\n` +
        `💡 Ví dụ: /search_order 100255`
      );
    }
    
    const searchOrderId = args[0].trim();
    
    if (!searchOrderId || searchOrderId.length === 0) {
      return ctx.reply('❌ Mã đơn hàng không hợp lệ!');
    }
    
    ctx.reply('⏳ Đang tìm kiếm giao dịch theo mã đơn hàng...');
    
    const accountNumber = MB_BANK_CARD_DEFAULT || '3999919072004';
    const transactions = await fetchTransactions(accountNumber);
    
    if (!transactions || transactions.length === 0) {
      return ctx.reply(`📭 Không có giao dịch nào\n💳 Tài khoản: ${accountNumber}`);
    }
    
    // Search for transactions with matching order ID in description or transactionDesc
    const foundTransactions = transactions.filter(tx => {
      const description = (tx.description || '').toLowerCase();
      const transactionDesc = (tx.transactionDesc || '').toLowerCase();
      const searchLower = searchOrderId.toLowerCase();
      
      return description.includes(searchLower) || transactionDesc.includes(searchLower);
    });
    
    if (foundTransactions.length === 0) {
      return ctx.reply(
        `📭 Không tìm thấy giao dịch nào với mã đơn hàng: ${searchOrderId}\n` +
        `💳 Tài khoản: ${accountNumber}`
      );
    }
    
    let message = `🔍 KẾT QUẢ TÌM KIẾM\n\n`;
    message += `📦 Mã đơn hàng tìm kiếm: ${searchOrderId}\n`;
    message += `💳 Tài khoản: ${accountNumber}\n`;
    message += `📊 Tìm thấy: ${foundTransactions.length} giao dịch\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n`;
    
    // Show all found transactions
    foundTransactions.forEach((transaction, index) => {
      message += formatTransaction(transaction, index + 1);
      message += `\n`;
      // Add separator between transactions (except for the last one)
      if (index < foundTransactions.length - 1) {
        message += `\n`;
      }
    });
    
    // Split message if too long
    if (message.length > 4000) {
      const lines = message.split('\n');
      let currentChunk = '';
      
      for (const line of lines) {
        if ((currentChunk + line + '\n').length > 4000) {
          if (currentChunk) {
            await ctx.reply(currentChunk.trim());
            currentChunk = '';
          }
        }
        currentChunk += line + '\n';
      }
      
      if (currentChunk.trim()) {
        await ctx.reply(currentChunk.trim());
      }
    } else {
      await ctx.reply(message);
    }
  } catch (error) {
    console.error('Search order error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /logs - View system logs and connection status
bot.command('logs', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    
    let message = `📋 LOGS VÀ TRẠNG THÁI HỆ THỐNG\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    // Bot status
    message += `🤖 Bot Status:\n`;
    message += `   • Trạng thái: ${bot ? '✅ Đang chạy' : '❌ Không chạy'}\n`;
    message += `   • Bot Token: ${BOT_TOKEN ? BOT_TOKEN.substring(0, 15) + '...' : '❌ Chưa cấu hình'}\n\n`;
    
    // MongoDB status
    message += `🔌 MongoDB Status:\n`;
    if (mongoClient) {
      try {
        // Try to ping the database to check connection
        let isConnected = false;
        if (db) {
          try {
            await db.admin().ping();
            isConnected = true;
          } catch (pingErr) {
            isConnected = false;
          }
        } else {
          // Check topology if available
          isConnected = mongoClient.topology && mongoClient.topology.isConnected();
        }
        message += `   • Trạng thái: ${isConnected ? '✅ Đã kết nối' : '⚠️ Đã khởi tạo nhưng chưa kết nối'}\n`;
        message += `   • Database: ${db ? MONGO_DB_NAME : '❌ Chưa chọn database'}\n`;
      } catch (err) {
        message += `   • Trạng thái: ❌ Lỗi kiểm tra: ${err.message}\n`;
      }
    } else {
      message += `   • Trạng thái: ❌ Chưa khởi tạo\n`;
    }
    message += `   • MONGO_URI: ${MONGO_URI ? MONGO_URI.substring(0, 30) + '...' : '❌ Chưa cấu hình'}\n`;
    message += `   • MONGO_DB_NAME: ${MONGO_DB_NAME || '❌ Chưa cấu hình'}\n\n`;
    
    // Cron job status
    message += `⏰ Cron Job Status:\n`;
    message += `   • Trạng thái: ${cronJob ? '✅ Đang chạy' : '❌ Chưa khởi động'}\n`;
    if (lastCronCheckTime) {
      const lastCheck = new Date(lastCronCheckTime);
      const timeDiff = Math.floor((Date.now() - lastCronCheckTime) / 1000);
      message += `   • Lần cuối check: ${lastCheck.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}\n`;
      message += `   • Cách đây: ${timeDiff} giây\n`;
      if (timeDiff > 120) {
        message += `   • ⚠️ Cảnh báo: Quá 2 phút\n`;
      }
    } else {
      message += `   • Chưa có lần check nào\n`;
    }
    message += `\n`;
    
    // Subscribers and Admins
    message += `👥 Người dùng:\n`;
    message += `   • Subscribers: ${subscribedUsers.size}\n`;
    message += `   • Admins: ${adminUsers.size}\n`;
    message += `\n`;
    
    // Last transaction
    message += `📊 Giao dịch:\n`;
    const lastTx = loadLastTransaction(true);
    if (lastTx) {
      const txId = getTransactionId(lastTx);
      message += `   • Giao dịch cuối: ${txId}\n`;
      message += `   • Ngày: ${lastTx.transactionDate || 'N/A'} ${lastTx.transactionTime || ''}\n`;
    } else {
      message += `   • Chưa có giao dịch nào được lưu\n`;
    }
    message += `\n`;
    
    // Pending notifications
    message += `📬 Pending Notifications:\n`;
    message += `   • Số đơn chờ gửi: ${pendingNotifications.size}\n`;
    if (pendingNotifications.size > 0) {
      const orderIds = Array.from(pendingNotifications.keys()).slice(0, 5);
      message += `   • Danh sách (tối đa 5): ${orderIds.join(', ')}\n`;
      if (pendingNotifications.size > 5) {
        message += `   • ... và ${pendingNotifications.size - 5} đơn hàng khác\n`;
      }
      message += `   • Sử dụng /resend_notifications để gửi lại\n`;
    }
    message += `\n`;
    
    // System info
    message += `🖥️ Thông tin hệ thống:\n`;
    message += `   • Node.js: ${process.version}\n`;
    message += `   • Platform: ${process.platform}\n`;
    message += `   • Uptime: ${Math.floor(process.uptime() / 60)} phút\n`;
    message += `   • Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB\n`;
    message += `\n`;
    
    message += `🕐 Thời gian hiện tại:\n`;
    message += `   • ${timestamp}`;
    
    ctx.reply(message);
  } catch (error) {
    console.error('Logs error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /reconnect_db - Reconnect to MongoDB
bot.command('reconnect_db', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    ctx.reply('⏳ Đang reconnect đến MongoDB...');
    
    // Close existing connections
    if (mongoClient) {
      try {
        await mongoClient.close();
        console.log('✅ Đã đóng MongoDB client cũ');
      } catch (err) {
        console.error('⚠️ Lỗi khi đóng MongoDB client:', err.message);
      }
      mongoClient = null;
      db = null;
    }
    
    // Wait a bit before reconnecting
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Reconnect
    await initMongoDB();
    
    ctx.reply(
      `✅ Đã reconnect MongoDB thành công!\n\n` +
      `🔌 Trạng thái:\n` +
      `   • MongoDB: ✅ Đã kết nối\n` +
      `   • Database: ${MONGO_DB_NAME}\n\n` +
      `💡 Kết nối đã được khôi phục.`
    );
  } catch (error) {
    console.error('Reconnect DB error:', error);
    ctx.reply(
      `❌ Lỗi khi reconnect MongoDB:\n\n` +
      `📋 Chi tiết: ${error.message}\n\n` +
      `💡 Kiểm tra:\n` +
      `   • MONGO_URI có đúng không?\n` +
      `   • MONGO_DB_NAME có đúng không?\n` +
      `   • MongoDB server có đang chạy không?`
    );
  }
});

// Command: /resend_notifications - Resend pending notifications
bot.command('resend_notifications', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    if (pendingNotifications.size === 0) {
      return ctx.reply('ℹ️ Không có đơn hàng nào chờ gửi thông báo');
    }
    
    ctx.reply(`⏳ Đang gửi lại ${pendingNotifications.size} đơn hàng chờ thông báo...`);
    
    const result = await resendPendingNotifications();
    
    let message = `✅ Hoàn thành resend notifications:\n\n`;
    message += `   • Thành công: ${result.sent}\n`;
    message += `   • Thất bại: ${result.failed}\n`;
    message += `   • Bỏ qua: ${result.skipped}\n\n`;
    
    if (pendingNotifications.size > 0) {
      message += `⚠️ Còn ${pendingNotifications.size} đơn hàng chưa gửi được\n`;
      message += `💡 Kiểm tra CheckNotifiOrder bot có đang hoạt động không`;
    } else {
      message += `✅ Đã gửi hết tất cả đơn hàng!`;
    }
    
    ctx.reply(message);
  } catch (error) {
    console.error('Resend notifications error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /reconnect_server - Reconnect to Telegram API
bot.command('reconnect_server', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    ctx.reply('⏳ Đang reconnect đến Telegram API...');
    
    // Test connection by calling getMe
    try {
      const botInfo = await bot.telegram.getMe();
      
      ctx.reply(
        `✅ Kết nối Telegram API thành công!\n\n` +
        `🤖 Bot Info:\n` +
        `   • Username: ${botInfo.username}\n` +
        `   • First Name: ${botInfo.first_name}\n` +
        `   • Bot ID: ${botInfo.id}\n\n` +
        `💡 Bot đang hoạt động bình thường.`
      );
    } catch (error) {
      // If getMe fails, try to restart the bot
      console.error('❌ Lỗi khi test kết nối Telegram:', error);
      
      try {
        // Stop current bot instance
        await bot.stop();
        
        // Wait a bit
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Restart bot
        await bot.launch();
        
        // Test again
        const botInfo = await bot.telegram.getMe();
        
        ctx.reply(
          `✅ Đã reconnect Telegram API thành công!\n\n` +
          `🤖 Bot Info:\n` +
          `   • Username: ${botInfo.username}\n` +
          `   • First Name: ${botInfo.first_name}\n` +
          `   • Bot ID: ${botInfo.id}\n\n` +
          `💡 Bot đã được khởi động lại.`
        );
      } catch (restartError) {
        console.error('❌ Lỗi khi restart bot:', restartError);
        ctx.reply(
          `❌ Lỗi khi reconnect Telegram API:\n\n` +
          `📋 Chi tiết: ${restartError.message}\n\n` +
          `💡 Kiểm tra:\n` +
          `   • BOT_TOKEN có đúng không?\n` +
          `   • Internet connection có ổn định không?\n` +
          `   • Telegram API có đang hoạt động không?`
        );
      }
    }
  } catch (error) {
    console.error('Reconnect server error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /add_notifi_order <chat_id> - Add chat ID to receive CheckNotifiOrder notifications
bot.command('add_notifi_order', (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 0) {
      ctx.reply(
        '❌ Thiếu tham số!\n\n' +
        '📋 Cách sử dụng:\n' +
        '/add_notifi_order <chat_id>\n\n' +
        '💡 Ví dụ:\n' +
        '/add_notifi_order 123456789\n\n' +
        '📝 Lưu ý:\n' +
        '• Chat ID phải là số hợp lệ\n' +
        '• Chat ID này sẽ nhận thông báo đơn hàng từ bot CheckNotifiOrder\n' +
        '• Sử dụng /list_notifi_order để xem danh sách chat ID đã thêm'
      );
      return;
    }
    
    const chatId = args[0].trim();
    
    // Validate chat ID (should be numeric)
    if (!/^\d+$/.test(chatId)) {
      ctx.reply('❌ Chat ID không hợp lệ! Chat ID phải là số.');
      return;
    }
    
    const result = addNotifiOrderChatId(chatId);
    
    if (result.added) {
      ctx.reply(
        `✅ Đã thêm chat ID ${chatId} vào danh sách nhận thông báo CheckNotifiOrder!\n\n` +
        `📱 Tổng số chat ID: ${notifiOrderChatIds.size}\n\n` +
        `💡 Chat ID này sẽ nhận thông báo đơn hàng khi có đơn hàng mới với trạng thái "Đang xử lý".`
      );
    } else if (result.reason === 'exists') {
      ctx.reply(
        `ℹ️ Chat ID ${chatId} đã có trong danh sách nhận thông báo CheckNotifiOrder.\n\n` +
        `📱 Tổng số chat ID: ${notifiOrderChatIds.size}`
      );
    } else {
      ctx.reply(`❌ Lỗi: Không thể thêm chat ID ${chatId}.`);
    }
  } catch (error) {
    console.error('Add notifi order error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /list_notifi_order - List all chat IDs receiving CheckNotifiOrder notifications
bot.command('list_notifi_order', (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    const chatIdsList = Array.from(notifiOrderChatIds);
    const envChatId = CHECK_NOTIFI_ORDER_CHAT_ID || 'Chưa cấu hình';
    
    let message = `📋 DANH SÁCH CHAT ID NHẬN THÔNG BÁO CHECKNOTIFIORDER\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📱 Từ file cấu hình (.env):\n`;
    message += `   • CHECK_NOTIFI_ORDER_CHAT_ID: ${envChatId}\n\n`;
    message += `📝 Từ danh sách quản lý (${chatIdsList.length} chat ID):\n`;
    
    if (chatIdsList.length === 0) {
      message += `   • Chưa có chat ID nào\n\n`;
    } else {
      chatIdsList.forEach((id, index) => {
        message += `   ${index + 1}. ${id}\n`;
      });
      message += `\n`;
    }
    
    message += `📊 Tổng số chat ID sẽ nhận thông báo: ${chatIdsList.length + (CHECK_NOTIFI_ORDER_CHAT_ID ? 1 : 0)}\n\n`;
    message += `💡 Sử dụng /add_notifi_order <chat_id> để thêm chat ID mới\n`;
    message += `💡 Sử dụng /remove_notifi_order <chat_id> để xóa chat ID`;
    
    ctx.reply(message);
  } catch (error) {
    console.error('List notifi order error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Command: /remove_notifi_order <chat_id> - Remove chat ID from CheckNotifiOrder notifications
bot.command('remove_notifi_order', (ctx) => {
  if (!requireAdmin(ctx)) return;
  
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 0) {
      ctx.reply(
        '❌ Thiếu tham số!\n\n' +
        '📋 Cách sử dụng:\n' +
        '/remove_notifi_order <chat_id>\n\n' +
        '💡 Ví dụ:\n' +
        '/remove_notifi_order 123456789\n\n' +
        '📝 Lưu ý:\n' +
        '• Chỉ có thể xóa chat ID từ danh sách quản lý\n' +
        '• Không thể xóa CHECK_NOTIFI_ORDER_CHAT_ID từ .env bằng lệnh này'
      );
      return;
    }
    
    const chatId = args[0].trim();
    const result = removeNotifiOrderChatId(chatId);
    
    if (result.removed) {
      ctx.reply(
        `✅ Đã xóa chat ID ${chatId} khỏi danh sách nhận thông báo CheckNotifiOrder!\n\n` +
        `📱 Tổng số chat ID còn lại: ${notifiOrderChatIds.size}`
      );
    } else if (result.reason === 'not_found') {
      ctx.reply(
        `ℹ️ Chat ID ${chatId} không có trong danh sách quản lý.\n\n` +
        `💡 Sử dụng /list_notifi_order để xem danh sách chat ID hiện tại.`
      );
    } else {
      ctx.reply(`❌ Lỗi: Không thể xóa chat ID ${chatId}.`);
    }
  } catch (error) {
    console.error('Remove notifi order error:', error);
    ctx.reply(`❌ Lỗi: ${error.message}`);
  }
});

// Extract order ID from transaction description
  // Supports new format: 3 letters + 5 digits (e.g., "AEM10050")
  // Also supports old format for backward compatibility
const extractOrderIdFromDescription = (description) => {
  if (!description) return null;
  
    // Try to match new format: 3 uppercase letters + 5 digits (e.g., "AEM10050")
    const newFormatMatch = description.match(/\b([A-Z]{3}\d{5})\b/i);
    if (newFormatMatch && newFormatMatch[1]) {
      return newFormatMatch[1].toUpperCase();
    }
    
    // Try to find old order ID patterns (e.g., "100255", "DH100255", "ORDER100255") for backward compatibility
  const patterns = [
    /(?:DH|ORDER|MA|MADH|ORDERID|ID)[\s:]*(\d+)/i,
      /\b(\d{4,})\b/, // Match 4+ digit numbers (old format)
  ];
  
  for (const pattern of patterns) {
    const match = description.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  
  return null;
};

// Check if order ID matches in transaction description
const matchOrderIdInTransaction = (orderId, transaction) => {
  if (!orderId || !transaction) return false;
  
  const description = (transaction.description || '').toLowerCase();
  const transactionDesc = (transaction.transactionDesc || '').toLowerCase();
  const orderIdLower = orderId.toLowerCase();
  
  // Direct match (works for both new format "AEM10050" and old format "10050")
  if (description.includes(orderIdLower) || transactionDesc.includes(orderIdLower)) {
    return true;
  }
  
  // Extract order ID from description and compare
  const extractedOrderId = extractOrderIdFromDescription(transaction.description || transaction.transactionDesc);
  if (extractedOrderId && extractedOrderId === orderId) {
    return true;
  }
  
  return false;
};

// Check if transaction amount matches order total price
// Allows small difference due to rounding (within 100 VND)
const matchAmountInTransaction = (orderTotalPrice, transaction) => {
  if (!orderTotalPrice || !transaction) return false;
  
  // Get transaction amount from various possible fields
  const transactionAmount = parseFloat(
    transaction.amount || 
    transaction.creditAmount || 
    transaction.debitAmount || 
    0
  );
  
  if (transactionAmount <= 0) return false;
  
  const orderAmount = parseFloat(orderTotalPrice) || 0;
  if (orderAmount <= 0) return false;
  
  // Compare amounts (allow small difference up to 100 VND for rounding)
  const difference = Math.abs(transactionAmount - orderAmount);
  return difference <= 100;
};

// Format currency for order messages
const formatCurrencyForOrder = (amount) => {
  const num = amount ?? 0;
  return new Intl.NumberFormat('vi-VN').format(num) + ' ₫';
};

// Format trạng thái xử lý đơn hàng (orderStatus) cho message
const formatOrderStatus = (status) => {
  const statusMap = {
    pending_payment: 'Chờ thanh toán',
    paid: 'Đã thanh toán',
    processing: 'Đang xử lý',
    completed: 'Đã xử lý',
    cancelled: 'Đã huỷ',
    warranty_pending: 'Đang bảo hành',
    warranty_completed: 'Đã bảo hành',
    refunded: 'Đã hoàn tiền',
  };
  return statusMap[status] || status;
};

// Format trạng thái thanh toán (paymentStatus) cho message
const formatPaymentStatus = (status) => {
  const statusMap = {
    unpaid: 'Chưa thanh toán',
    pending: 'Đang chờ thanh toán',
    paid: 'Đã thanh toán',
    failed: 'Thanh toán thất bại',
    refunded: 'Đã hoàn tiền',
  };
  return statusMap[status] || status;
};

// Format date time for order messages
const formatOrderDateTime = (date) => {
  if (!date) {
    date = new Date();
  }
  const d = new Date(date);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
};

// Escape markdown special characters
const escapeMarkdown = (text) => {
  if (!text) return '';
  return String(text)
    .replace(/\_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\~/g, '\\~')
    .replace(/\`/g, '\\`');
};

// Function to send message to CheckNotifiOrder bot via Telegram API
// Returns: { success: boolean, sentTo: number, failed: number }
const sendToCheckNotifiOrder = async (message, chatId = null) => {
  if (!CHECK_NOTIFI_ORDER_BOT_TOKEN) {
    return { success: false, sentTo: 0, failed: 0, error: 'CHECK_NOTIFI_ORDER_BOT_TOKEN chưa được cấu hình' };
  }

  try {
    // Collect all target chat IDs
    const targetChatIds = new Set();
    
    // Add specific chatId if provided
    if (chatId) {
      targetChatIds.add(String(chatId));
    }
    
    // Add CHECK_NOTIFI_ORDER_CHAT_ID if configured
    if (CHECK_NOTIFI_ORDER_CHAT_ID) {
      targetChatIds.add(String(CHECK_NOTIFI_ORDER_CHAT_ID));
    }
    
    // Add all chat IDs from the managed list
    notifiOrderChatIds.forEach(id => {
      if (id) {
        targetChatIds.add(String(id));
      }
    });
    
    if (targetChatIds.size === 0) {
      const errorMsg = '⚠️ Không có chat ID nào được cấu hình để nhận thông báo CheckNotifiOrder. Sử dụng lệnh /add_notifi_order <chat_id> để thêm.';
      console.log(errorMsg);
      return { success: false, sentTo: 0, failed: 0, error: errorMsg };
    }

    const telegramApiUrl = `https://api.telegram.org/bot${CHECK_NOTIFI_ORDER_BOT_TOKEN}/sendMessage`;
    let successCount = 0;
    let failCount = 0;
    
    // Send message to all target chat IDs with retry
    for (const targetChatId of targetChatIds) {
      try {
        await retryApiCall(async () => {
        const response = await axios.post(telegramApiUrl, {
          chat_id: targetChatId,
          text: message,
          disable_web_page_preview: true,
        }, {
          timeout: 10000,
        });

        if (response.data && response.data.ok) {
          console.log(`✅ Đã gửi tin nhắn đến CheckNotifiOrder bot (chat ${targetChatId})`);
            return response.data;
        }
          throw new Error(`Telegram API returned error: ${JSON.stringify(response.data)}`);
        });
        successCount++;
      } catch (error) {
        console.error(`❌ Lỗi khi gửi tin nhắn đến CheckNotifiOrder bot (chat ${targetChatId}) sau ${3} lần thử:`, error.message);
        failCount++;
      }
    }
    
    const success = successCount > 0;
    return { success, sentTo: successCount, failed: failCount };
  } catch (error) {
    console.error(`❌ Lỗi khi gửi tin nhắn đến CheckNotifiOrder bot:`, error.message);
    return { success: false, sentTo: 0, failed: 0, error: error.message };
  }
};

// Retry wrapper function for API calls
const retryApiCall = async (apiCall, maxRetries = 3, delay = 1000) => {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await apiCall();
    } catch (error) {
      lastError = error;
      
      // Don't retry on 4xx errors (client errors) except 408 (timeout) and 429 (rate limit)
      if (error.response) {
        const status = error.response.status;
        if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
          throw error; // Don't retry client errors
        }
      }
      
      if (attempt < maxRetries) {
        const waitTime = delay * Math.pow(2, attempt - 1); // Exponential backoff
        console.log(`⚠️ API call failed (attempt ${attempt}/${maxRetries}), retrying in ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        console.error(`❌ API call failed after ${maxRetries} attempts`);
      }
    }
  }
  
  throw lastError;
};

// Function to call Server API to get order by orderId
const getOrderByOrderId = async (orderId) => {
  if (!SERVER_API_URL || !BOT_API_KEY) {
    throw new Error('SERVER_API_URL và BOT_API_KEY chưa được cấu hình');
  }

  return retryApiCall(async () => {
    const response = await axios.get(`${SERVER_API_URL}/orders/bot/${orderId}`, {
      headers: {
        'x-api-key': BOT_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    if (response.data && response.data.success) {
      return response.data.data;
    }

    throw new Error(response.data?.message || 'Không thể lấy thông tin đơn hàng');
  });
};

// Function to call Server API to update order status to processing
const updateOrderStatusToProcessing = async (orderId, adminNote = null) => {
  if (!SERVER_API_URL || !BOT_API_KEY) {
    throw new Error('SERVER_API_URL và BOT_API_KEY chưa được cấu hình');
  }

  return retryApiCall(async () => {
    const response = await axios.put(
      `${SERVER_API_URL}/orders/bot/${orderId}/status/processing`,
      adminNote ? { adminNote } : {},
      {
        headers: {
          'x-api-key': BOT_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    if (response.data && response.data.success) {
      return response.data.data;
    }

    throw new Error(response.data?.message || 'Không thể cập nhật trạng thái đơn hàng');
  });
};

// Extract only essential fields from transaction (from bank response)
// Handles both original bank response and normalized transaction
const extractBankTransactionData = (transaction) => {
  // Get transactionID (try all possible fields)
  const transactionID = transaction.transactionID || transaction.transactionId || transaction.refNo || transaction.tranId || '';
  
  // Get amount (could be string or number)
  const amount = transaction.amount || '';
  
  // Get description (prefer description over transactionDesc)
  const description = transaction.description || transaction.transactionDesc || '';
  
  // Get transactionDate - reconstruct if normalized (date + time)
  // In normalized format, transactionDate might be split into date and time
  let transactionDate = transaction.transactionDate || '';
  if (!transactionDate || (!transactionDate.includes(' ') && transaction.transactionTime)) {
    // Reconstruct from normalized format (date + time)
    const date = transaction.transactionDate || '';
    const time = transaction.transactionTime || '';
    if (date && time) {
      transactionDate = `${date} ${time}`;
    } else if (date) {
      transactionDate = date;
    } else if (time) {
      transactionDate = time;
    }
  }
  
  // Get type (default to IN for credit transactions)
  const type = transaction.type || (transaction.creditAmount ? 'IN' : 'OUT');
  
  // Only return the 5 essential fields from original bank response
  return {
    transactionID,
    amount: amount.toString(),
    description,
    transactionDate,
    type,
  };
};

// Function to call Server API to create payment from banking transaction
const createPaymentFromBanking = async (orderId, transactionData) => {
  if (!SERVER_API_URL || !BOT_API_KEY) {
    throw new Error('SERVER_API_URL và BOT_API_KEY chưa được cấu hình');
  }

  // Extract only essential fields from bank response
  const cleanTransactionData = extractBankTransactionData(transactionData);

  return retryApiCall(async () => {
    const response = await axios.post(
      `${SERVER_API_URL}/payments/bot/banking`,
      {
        orderId,
        transactionData: cleanTransactionData,
      },
      {
        headers: {
          'x-api-key': BOT_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    if (response.data && response.data.success) {
      return response.data.data;
    }

    throw new Error(response.data?.message || 'Không thể tạo giao dịch thanh toán');
  }).catch(error => {
    // Handle specific case: payment already exists (don't retry for this)
    if (error.response && error.response.status === 400 && error.response.data?.message?.includes('đã được ghi nhận')) {
      console.log(`ℹ️ Giao dịch thanh toán cho đơn hàng ${orderId} đã được ghi nhận trước đó`);
      return null; // Return null to indicate it's already created
    }
    throw error;
  });
};

// Function to resend pending notifications
const resendPendingNotifications = async (maxRetries = 10) => {
  const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  
  if (pendingNotifications.size === 0) {
    console.log(`[${timestamp}] ℹ️ Không có đơn hàng nào chờ gửi thông báo`);
    return { sent: 0, failed: 0, skipped: 0 };
  }

  console.log(`[${timestamp}] 🔄 Bắt đầu gửi lại ${pendingNotifications.size} đơn hàng chờ thông báo...`);

  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const toRemove = [];

  for (const [orderId, pendingItem] of pendingNotifications.entries()) {
    try {
      // Skip if retry count exceeded
      if (pendingItem.retryCount >= maxRetries) {
        console.log(`[${timestamp}] ⏭️ Bỏ qua đơn hàng ${orderId} (đã retry ${pendingItem.retryCount} lần)`);
        skippedCount++;
        continue;
      }

      // Try to get fresh order data from API if available
      let orderData = pendingItem.orderData;
      try {
        if (SERVER_API_URL && BOT_API_KEY) {
          const freshData = await getOrderByOrderId(orderId);
          orderData = freshData.order;
          console.log(`[${timestamp}] ✅ Đã lấy dữ liệu mới cho đơn hàng ${orderId} từ API`);
        }
      } catch (apiError) {
        console.log(`[${timestamp}] ⚠️ Không thể lấy dữ liệu mới từ API, sử dụng dữ liệu cũ cho đơn hàng ${orderId}`);
      }

      // Always try to update order status to processing via API
      if (SERVER_API_URL && BOT_API_KEY) {
        try {
          const adminNote = `Đơn hàng đã được thanh toán - Bot tự động cập nhật (retry). Giao dịch: ${pendingItem.transactionId || 'N/A'}`;
          orderData = await updateOrderStatusToProcessing(orderId, adminNote);
          console.log(`[${timestamp}] ✅ Đã cập nhật đơn hàng ${orderId} thành processing qua API`);
        } catch (apiError) {
          console.log(`[${timestamp}] ⚠️ Không thể cập nhật đơn hàng ${orderId} qua API:`, apiError.message);
          // Continue with notification even if API update fails
        }
      }

      // Send notification
      const orderMessage = buildOrderMessage(orderData, { forcePaymentStatus: 'paid' });
      const notificationResult = await sendToCheckNotifiOrder(orderMessage);

      if (notificationResult.success) {
        console.log(`[${timestamp}] ✅ Đã gửi lại thông báo đơn hàng ${orderId} (${notificationResult.sentTo} chat)`);
        
        // After notification succeeded, create payment record if we have transaction data
        if (pendingItem.transactionId && SERVER_API_URL && BOT_API_KEY) {
          try {
            // Reconstruct transaction data from pending item (only essential fields)
            const transactionData = {
              transactionID: pendingItem.transactionId,
              amount: pendingItem.orderData?.totalPrice?.toString() || '',
              description: `CUSTOMER ${orderId}`,
              transactionDate: pendingItem.createdAt ? new Date(pendingItem.createdAt).toLocaleString('vi-VN') : '',
              type: 'IN',
            };
            const payment = await createPaymentFromBanking(orderId, transactionData);
            if (payment) {
              console.log(`[${timestamp}] ✅ Đã tạo payment record cho đơn hàng ${orderId} (retry)`);
            }
          } catch (paymentError) {
            console.log(`[${timestamp}] ⚠️ Không thể tạo payment record cho đơn hàng ${orderId}:`, paymentError.message);
          }
        }
        
        toRemove.push(orderId);
        sentCount++;
      } else {
        // Increment retry count
        pendingItem.retryCount = (pendingItem.retryCount || 0) + 1;
        pendingNotifications.set(orderId, pendingItem);
        failedCount++;
        console.log(`[${timestamp}] ❌ Không thể gửi lại thông báo đơn hàng ${orderId} (retry ${pendingItem.retryCount}/${maxRetries})`);
      }
    } catch (error) {
      console.error(`[${timestamp}] ❌ Lỗi khi xử lý đơn hàng ${orderId}:`, error.message);
      failedCount++;
    }
  }

  // Remove successfully sent notifications
  toRemove.forEach(orderId => {
    removePendingNotification(orderId);
  });

  console.log(`[${timestamp}] ✅ Hoàn thành resend: ${sentCount} thành công, ${failedCount} thất bại, ${skippedCount} bỏ qua`);

  return { sent: sentCount, failed: failedCount, skipped: skippedCount };
};

// Build order notification message for CheckNotifiOrder bot (plain text, no markdown)
const buildOrderMessage = (orderDoc, options = {}) => {
  const { forcePaymentStatus } = options;
  const lines = [];
  lines.push('🔔 Có đơn hàng mới thanh toán thành công');
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━');

  // _Id
  if (orderDoc?._id) {
    lines.push(`🆔 _Id: ${orderDoc._id.toString()}`);
    lines.push('');
  }
  // UserId
  if (orderDoc?.userId) {
    lines.push(`👤 UserId: ${orderDoc.userId.toString()}`);
    lines.push('');
  }
  
  // Mã đơn
  if (orderDoc?.orderId) {
    lines.push(`📄 Mã đơn: ${orderDoc.orderId}`);
    lines.push('');
  }

  // Tổng dịch vụ đặt
  const totalItems = orderDoc?.items?.length || 0;
  lines.push(`🛒 Tổng Dịch Vụ Đặt: ${totalItems}`);
  lines.push('');
  // Tổng tiền đơn hàng
  if (orderDoc?.totalPrice !== undefined) {
    lines.push(`💵 Tổng tiền đơn hàng: ${formatCurrencyForOrder(orderDoc.totalPrice)}`);
    lines.push('');
  }

  // Trạng thái đơn hàng (xử lý/cấp account)
  if (orderDoc?.orderStatus) {
    lines.push(`📌 Trạng thái đơn: ${formatOrderStatus(orderDoc.orderStatus)}`);
    lines.push('');
  }

  // Trạng thái thanh toán
  const paymentStatusToShow = forcePaymentStatus || orderDoc?.paymentStatus || 'paid';
  lines.push(`💳 Thanh toán: ${formatPaymentStatus(paymentStatusToShow)}`);
  lines.push('');

  // SĐT
  if (orderDoc?.phoneNumber) {
    lines.push(`📱 SĐT: ${orderDoc.phoneNumber}`);
    lines.push('');
  }

  // Email tặng
  if (orderDoc?.emailGiftForFriend) {
    lines.push(`📧 Email tặng: ${orderDoc.emailGiftForFriend}`);
    lines.push('');
  }

  // Ghi chú KH
  if (orderDoc?.userNote) {
    lines.push(`📝 Ghi chú KH: ${orderDoc.userNote}`);
    lines.push('');
  }

  // Thời gian
  const timeToShow = orderDoc?.updatedAt || orderDoc?.createdAt || new Date();
  lines.push(`⏰ Thời gian: ${formatOrderDateTime(timeToShow)}`);

  return lines.join('\n');
};

// Function to check transactions and match with pending orders
const checkTransactionsAndMatchOrders = async (db) => {
  const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  console.log(`\n[${timestamp}] 🔄 Bắt đầu kiểm tra giao dịch và so khớp với đơn hàng...`);
  
  try {
    if (!MB_USERNAME || !MB_PASSWORD) {
      console.log(`[${timestamp}] ⚠️ Chưa cấu hình MB_USERNAME và MB_PASSWORD`);
      return;
    }

    const accountNumber = MB_BANK_CARD_DEFAULT || '3999919072004';
    const orders = db.collection(ORDER_COLLECTION);

    // Fetch transactions from API (no fallback - use current method only)
    console.log(`[${timestamp}] 📡 Đang lấy giao dịch từ API (phương thức: ${currentApiMethod})...`);
    const transactions = await fetchTransactions(accountNumber);

    if (!transactions || transactions.length === 0) {
      console.log(`[${timestamp}] 📭 Không có giao dịch nào`);
      return;
    }

    console.log(`[${timestamp}] 📊 Tổng số giao dịch: ${transactions.length}`);

    // Get last saved transaction
    const lastSavedTransaction = loadLastTransaction(true);
    const lastSavedTxId = lastSavedTransaction ? getTransactionId(lastSavedTransaction) : null;

    // Get most recent transaction
    const mostRecentTransaction = transactions[0];
    const mostRecentTxId = getTransactionId(mostRecentTransaction);

    // If no last saved transaction, save and return
    if (!lastSavedTxId) {
      console.log(`[${timestamp}] 🆕 Lần đầu kiểm tra, lưu giao dịch mới nhất`);
      saveLastTransaction(mostRecentTransaction);
      return;
    }

    // If same transaction, no new transactions
    if (lastSavedTxId === mostRecentTxId) {
      console.log(`[${timestamp}] ✅ Không có giao dịch mới`);
      return;
    }

    // Get new transactions
    let newTransactions = [];
    for (const tx of transactions) {
      const txId = getTransactionId(tx);
      if (txId === lastSavedTxId) {
        break;
      }
      newTransactions.push(tx);
    }

    if (newTransactions.length === 0) {
      console.log(`[${timestamp}] ✅ Không có giao dịch mới`);
      saveLastTransaction(mostRecentTransaction);
      return;
    }

    console.log(`[${timestamp}] 🔍 Tìm thấy ${newTransactions.length} giao dịch mới`);

    // Get all orders chưa thanh toán (logic thanh toán: theo paymentStatus)
    const pendingOrders = await orders
      .find({
        $or: [
          { paymentStatus: { $in: ['unpaid', 'pending'] } },
          // Backward compatibility: đơn cũ chưa có paymentStatus
          { paymentStatus: { $exists: false }, orderStatus: 'pending_payment' },
        ],
      })
      .toArray();
    console.log(`[${timestamp}] 📦 Tìm thấy ${pendingOrders.length} đơn hàng chưa thanh toán (paymentStatus unpaid/pending)`);

    // Match transactions with orders
    const matchedOrders = [];
    for (const transaction of newTransactions) {
      // Only check credit transactions (money coming in)
      const isCredit = transaction.type === 'IN' || parseFloat(transaction.creditAmount || 0) > 0;
      if (!isCredit) {
        continue;
      }

      for (const order of pendingOrders) {
        if (!order.orderId) continue;

        // Check if order ID matches in transaction description
        const orderIdMatches = matchOrderIdInTransaction(order.orderId, transaction);
        if (!orderIdMatches) continue;

        // Check if transaction amount matches order total price
        const amountMatches = matchAmountInTransaction(order.totalPrice, transaction);
        if (!amountMatches) {
          console.log(`[${timestamp}] ⚠️ Đơn hàng ${order.orderId} có mã khớp nhưng số tiền không khớp (Order: ${order.totalPrice}, Transaction: ${transaction.amount || transaction.creditAmount || 0})`);
          continue;
        }

        // Both orderId and amount match
          matchedOrders.push({
            order,
            transaction,
          });
          break; // One transaction can only match one order
      }
    }

    // Prepare recipient list for bank transaction notifications
    const recipients = new Set([...subscribedUsers, ...adminUsers]);

    // Always send bank transaction notifications to BotCheckPayment subscribers
    // This should happen regardless of whether orders are matched
    if (recipients.size > 0 && newTransactions.length > 0) {
      const transactionsToNotify = [...newTransactions].reverse();
      console.log(`[${timestamp}] 📤 Đang gửi thông báo ${transactionsToNotify.length} giao dịch ngân hàng mới đến ${recipients.size} người dùng...`);

      for (const transaction of transactionsToNotify) {
        const message = formatTransactionNotification(transaction, accountNumber);

        for (const userId of recipients) {
          try {
            if (message.length > 4000) {
              const chunks = message.match(/[\s\S]{1,4000}/g) || [];
              for (const chunk of chunks) {
                await bot.telegram.sendMessage(userId, chunk);
              }
            } else {
              await bot.telegram.sendMessage(userId, message);
            }
          } catch (error) {
            console.error(`[${timestamp}] ❌ Không thể gửi tin nhắn đến user ${userId}:`, error.message);
            if (error.response?.error_code === 403 || error.response?.error_code === 400) {
              removeSubscriber(userId, `Telegram error ${error.response?.error_code}`);
            }
          }
        }
      }

      console.log(`[${timestamp}] ✅ Đã gửi thông báo ${transactionsToNotify.length} giao dịch ngân hàng mới đến ${recipients.size} người dùng`);
    }

    if (matchedOrders.length === 0) {
      console.log(`[${timestamp}] ℹ️ Không tìm thấy đơn hàng nào khớp với giao dịch mới`);
      saveLastTransaction(mostRecentTransaction);
      return;
    }

    console.log(`[${timestamp}] ✅ Tìm thấy ${matchedOrders.length} đơn hàng khớp với giao dịch`);

    // Update matched orders to processing status via API and send order notifications
    for (const { order, transaction } of matchedOrders) {
      let orderData = null;
      let updatedOrder = null;
      let apiUpdateSuccess = false;

      try {
        // First, get order from API to ensure it exists and is still pending
        try {
          orderData = await getOrderByOrderId(order.orderId);
          console.log(`[${timestamp}] ✅ Đã lấy thông tin đơn hàng ${order.orderId} từ API`);
        } catch (apiError) {
          console.error(`[${timestamp}] ❌ Lỗi khi lấy đơn hàng ${order.orderId} từ API:`, apiError.message);
          // If API fails, use order from MongoDB as fallback
          orderData = { order };
          console.log(`[${timestamp}] ⚠️ Sử dụng order từ MongoDB làm fallback`);
        }

        // Check if order is still unpaid (logic thanh toán theo paymentStatus)
        const paymentStatus = orderData.order.paymentStatus || 'unpaid';
        if (paymentStatus !== 'unpaid' && paymentStatus !== 'pending') {
          console.log(
            `[${timestamp}] ⏭️ Đơn hàng ${order.orderId} có paymentStatus="${paymentStatus}", bỏ qua tạo thanh toán`
          );
          continue;
        }

        // Try to update order status to processing via API
        try {
          const adminNote = `Đơn hàng đã được thanh toán - Bot tự động cập nhật. Giao dịch: ${transaction.transactionID || transaction.transactionId || 'N/A'}`;
          updatedOrder = await updateOrderStatusToProcessing(order.orderId, adminNote);
          apiUpdateSuccess = true;
          console.log(`[${timestamp}] ✅ Đã cập nhật đơn hàng ${order.orderId} từ pending -> processing qua API`);
        } catch (apiError) {
          console.error(`[${timestamp}] ❌ Lỗi khi cập nhật đơn hàng ${order.orderId} qua API:`, apiError.message);
          // If API update fails, use order from MongoDB and mark as processing locally
          updatedOrder = orderData.order;
          updatedOrder.orderStatus = 'processing';
          console.log(`[${timestamp}] ⚠️ Sử dụng order từ MongoDB, sẽ cập nhật sau khi API hoạt động lại`);
        }

        // Always try to send notification, even if API update failed
        const orderMessage = buildOrderMessage(updatedOrder, { forcePaymentStatus: 'paid' });
        const notificationResult = await sendToCheckNotifiOrder(orderMessage);

        if (notificationResult.success) {
          console.log(`[${timestamp}] 📤 Đã gửi thông báo đơn hàng ${order.orderId} đến CheckNotifiOrder bot (${notificationResult.sentTo} chat)`);
          
          // After notification succeeded, create payment record
          try {
            const payment = await createPaymentFromBanking(order.orderId, transaction);
            if (payment) {
              console.log(`[${timestamp}] ✅ Đã tạo payment record cho đơn hàng ${order.orderId}`);
            }
          } catch (paymentError) {
            console.error(`[${timestamp}] ⚠️ Lỗi khi tạo payment record cho đơn hàng ${order.orderId}:`, paymentError.message);
            // Don't fail the whole process if payment creation fails
          }
          
          // Remove from pending if notification succeeded
          removePendingNotification(order.orderId);
          
          // If notification succeeded, it means CheckNotifiOrder is back online
          // Try to resend all pending notifications
          if (pendingNotifications.size > 0) {
            console.log(`[${timestamp}] 🔄 CheckNotifiOrder đã online, tự động resend ${pendingNotifications.size} đơn hàng chờ thông báo...`);
            setTimeout(async () => {
              await resendPendingNotifications();
            }, 2000); // Wait 2 seconds before resending
          }
        } else {
          console.error(`[${timestamp}] ❌ Không thể gửi thông báo đơn hàng ${order.orderId} đến CheckNotifiOrder bot`);
          // Add to pending notifications for retry later
          addPendingNotification(order.orderId, updatedOrder, transaction.transactionID || transaction.transactionId);
        }

        // If API update failed, add to pending for retry
        if (!apiUpdateSuccess) {
          addPendingNotification(order.orderId, updatedOrder, transaction.transactionID || transaction.transactionId);
        }
      } catch (err) {
        console.error(`[${timestamp}] ❌ Lỗi khi xử lý đơn hàng ${order.orderId}:`, err.message);
        // Add to pending if we have order data
        if (order) {
          addPendingNotification(order.orderId, order, transaction?.transactionID || transaction?.transactionId);
        }
      }
    }

    // Save most recent transaction
    saveLastTransaction(mostRecentTransaction);

    console.log(`[${timestamp}] ✅ Hoàn thành kiểm tra và cập nhật đơn hàng`);
  } catch (error) {
    console.error(`[${timestamp}] ❌ Lỗi khi kiểm tra giao dịch:`, error);
    console.error(`[${timestamp}] 📋 Chi tiết lỗi:`, error.message);
  }
};

// Function to check today's transactions
const checkTodayTransactions = async () => {
  const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  lastCronCheckTime = Date.now(); // Update last check time
  console.log(`\n[${timestamp}] 🔄 CRON JOB: Bắt đầu kiểm tra giao dịch...`);
  
  try {
    if (!MB_USERNAME || !MB_PASSWORD) {
      console.error(`[${timestamp}] ❌ Chưa cấu hình MB_USERNAME và MB_PASSWORD`);
      return;
    }

    const accountNumber = MB_BANK_CARD_DEFAULT || '3999919072004';

    console.log(`[${timestamp}] 📅 Đang lấy giao dịch cho tài khoản ${accountNumber} từ API (phương thức: ${currentApiMethod})`);

    const transactions = await fetchTransactions(accountNumber);

    console.log(`[${timestamp}] 📊 Tổng số giao dịch tìm thấy: ${transactions?.length || 0}`);

    if (!transactions || transactions.length === 0) {
      console.log(`[${timestamp}] 📭 Không có giao dịch nào`);
      return;
    }

    const lastSavedTransaction = loadLastTransaction(true);
    const lastSavedTxId = lastSavedTransaction ? getTransactionId(lastSavedTransaction) : null;

    const mostRecentTransaction = transactions[0];
    const mostRecentTxId = getTransactionId(mostRecentTransaction);
    console.log(`[${timestamp}] 🔍 Giao dịch mới nhất: ${mostRecentTxId}`);
    if (lastSavedTxId) {
      console.log(`[${timestamp}] 📋 Giao dịch đã lưu: ${lastSavedTxId}`);
    }

    if (!lastSavedTxId) {
      console.log(`[${timestamp}] 🆕 Lần đầu kiểm tra, lưu giao dịch mới nhất`);
      saveLastTransaction(mostRecentTransaction);
      console.log(`[${timestamp}] ✅ Đã lưu giao dịch mới nhất, chờ giao dịch tiếp theo`);
      return;
    }

    if (lastSavedTxId === mostRecentTxId) {
      console.log(`[${timestamp}] ✅ Không có giao dịch mới (giao dịch cuối cùng không thay đổi)`);
      return;
    }

    let newTransactions = [];
    for (const tx of transactions) {
      const txId = getTransactionId(tx);
      if (txId === lastSavedTxId) {
        break;
      }
      newTransactions.push(tx);
    }

    if (newTransactions.length === 0) {
      console.log(`[${timestamp}] ✅ Không có giao dịch mới`);
      return;
    }

    console.log(`[${timestamp}] 🔍 Tìm thấy ${newTransactions.length} giao dịch mới`);

    // Save the most recent transaction
    saveLastTransaction(mostRecentTransaction);

    // Prepare recipient list (include all subscribers + admins)
    const recipients = new Set([...subscribedUsers, ...adminUsers]);

    if (recipients.size === 0) {
      console.log(`[${timestamp}] ⚠️ Không có người dùng nào đăng ký nhận thông báo. Giao dịch sẽ không được gửi.`);
      console.log(`[${timestamp}] 💡 Người dùng cần gửi lệnh /start hoặc được admin thêm vào danh sách.`);
      return;
    }

    const transactionsToNotify = [...newTransactions].reverse();

    // Send notifications to all recipients
    // Send each new transaction separately for better clarity
    console.log(`[${timestamp}] 📤 Đang gửi thông báo ${transactionsToNotify.length} giao dịch mới đến ${recipients.size} người dùng...`);

    for (const transaction of transactionsToNotify) {
      const message = formatTransactionNotification(transaction, accountNumber);

      for (const userId of recipients) {
        try {
          if (message.length > 4000) {
            const chunks = message.match(/[\s\S]{1,4000}/g) || [];
            for (const chunk of chunks) {
              await bot.telegram.sendMessage(userId, chunk);
            }
          } else {
            await bot.telegram.sendMessage(userId, message);
          }
        } catch (error) {
          console.error(`[${timestamp}] ❌ Không thể gửi tin nhắn đến user ${userId}:`, error.message);
          if (error.response?.error_code === 403 || error.response?.error_code === 400) {
            removeSubscriber(userId, `Telegram error ${error.response?.error_code}`);
          }
        }
      }
    }

    console.log(`[${timestamp}] ✅ Đã gửi thông báo ${transactionsToNotify.length} giao dịch mới đến ${recipients.size} người dùng`);
  } catch (error) {
    console.error(`[${timestamp}] ❌ Lỗi khi kiểm tra giao dịch:`, error);
    console.error(`[${timestamp}] 📋 Chi tiết lỗi:`, error.message);
    if (error.stack) {
      console.error(`[${timestamp}] 📚 Stack trace:`, error.stack);
    }
  }
};

// Error handling
bot.catch((err, ctx) => {
  console.error(`❌ Error for ${ctx.updateType}:`, err);
  if (ctx.reply) {
    ctx.reply('❌ Đã xảy ra lỗi. Vui lòng thử lại sau.').catch(e => {
      console.error('Không thể gửi error message:', e);
    });
  }
});

// Start bot
console.log('🤖 Bot đang khởi động...');
console.log('📱 Bot Token:', BOT_TOKEN.substring(0, 15) + '...');
console.log('🔍 Đang kết nối với Telegram...');

// Load last transaction on startup
const lastTxOnStartup = loadLastTransaction();
if (lastTxOnStartup) {
  console.log('📂 Đã tải giao dịch cuối cùng khi khởi động bot');
} else {
  console.log('📂 Chưa có giao dịch nào được lưu (lần đầu chạy)');
}

const ADMINS_FILE = path.join(__dirname, 'admins.json');

// Initialize admin list from env first, then extend from admins.json
const ADMIN_CHAT_IDS = (process.env.TELEGRAM_ADMIN_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter((id) => id.length > 0);

const adminUsers = new Set(ADMIN_CHAT_IDS.filter((id) => id.length > 0));

function isAdmin(chatId) {
  if (adminUsers.size === 0) {
    return true;
  }
  return adminUsers.has(String(chatId));
}

function sendAdminOnlyMessage(ctx) {
  ctx.reply('⚠️ Lệnh này chỉ dành cho admin. Liên Hệ Admin để được hỗ trợ.');
}

function requireAdmin(ctx) {
  if (!isAdmin(ctx.from.id)) {
    sendAdminOnlyMessage(ctx);
    return false;
  }
  return true;
}

function saveAdmins() {
  persistJsonToFile(ADMINS_FILE, Array.from(adminUsers), 'danh sách admin');
}

function loadAdmins() {
  const data = readJsonFromFile(ADMINS_FILE, 'danh sách admin');
  if (Array.isArray(data)) {
    let restored = 0;
    data.forEach((id) => {
      if (!id) return;
      const idStr = String(id);
      if (!adminUsers.has(idStr)) {
        adminUsers.add(idStr);
        restored += 1;
      }
    });
    if (restored > 0) {
      console.log(`🛡️ Đã khôi phục thêm ${restored} admin từ admins.json.`);
    }
  } else {
    console.log('📂 Không tìm thấy danh sách admin bổ sung (admins.json).');
  }
}

loadAdmins();
loadSubscribers();
loadNotifiOrderChatIds();
loadPendingNotifications();
loadApiMethod();

// MongoDB client and database reference
let mongoClient = null;
let db = null;

// Initialize MongoDB connection (for querying pending orders only)
const initMongoDB = async () => {
  try {
    console.log('🔌 Đang kết nối MongoDB...');
    console.log(`📡 MONGO_URI: ${MONGO_URI.substring(0, 30)}...`);
    console.log(`📚 MONGO_DB_NAME: ${MONGO_DB_NAME}`);
    
    mongoClient = new MongoClient(MONGO_URI, {
      readPreference: 'primary',
      retryWrites: true,
      w: 'majority',
    });

    await mongoClient.connect();
    console.log('✅ Đã kết nối MongoDB thành công!');
    
    db = mongoClient.db(MONGO_DB_NAME);
    console.log('✅ MongoDB đã sẵn sàng để query pending orders');
  } catch (error) {
    console.error('❌ Lỗi kết nối MongoDB:', error);
    console.error('📋 Chi tiết:', error.message);
    throw error;
  }
};

// Start cron job BEFORE launching bot to ensure it's always running
console.log('⏰ Đang khởi động cron job kiểm tra giao dịch mỗi 1 phút...');
let cronJob = null;

// Test bot token first
bot.telegram.getMe().then(async (botInfo) => {
  console.log('✅ Kết nối thành công!');
  console.log('🤖 Bot info:', botInfo.username, `(${botInfo.first_name})`);
  console.log('📱 Bot ID:', botInfo.id);
  
  // Initialize MongoDB connection
  await initMongoDB();
  
  // Start cron job after MongoDB is connected
  cronJob = cron.schedule('* * * * *', () => {
    const now = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    console.log(`\n[${now}] ⏰ CRON TRIGGER: Chạy kiểm tra giao dịch và so khớp đơn hàng...`);
    if (db) {
      checkTransactionsAndMatchOrders(db);
    } else {
      console.log(`[${now}] ⚠️ MongoDB chưa kết nối, bỏ qua kiểm tra`);
    }
  }, {
    scheduled: true,
    timezone: "Asia/Ho_Chi_Minh"
  });
  console.log('✅ Cron job đã được khởi động!');
  console.log('📅 Timezone: Asia/Ho_Chi_Minh');
  console.log('⏱️  Lịch chạy: Mỗi phút (* * * * *)');
  
  // Launch bot after token is verified
  bot.launch().then(() => {
    console.log('✅ Bot đã sẵn sàng và đang lắng nghe!');
    console.log('💬 Bot đang chờ tin nhắn...');
    
    // Run initial check
    console.log('🔄 Sẽ chạy kiểm tra đầu tiên sau 5 giây...');
    setTimeout(() => {
      console.log('🚀 Chạy kiểm tra giao dịch và so khớp đơn hàng lần đầu...');
      if (db) {
        checkTransactionsAndMatchOrders(db);
      }
      checkTodayTransactions();
    }, 5000); // Wait 5 seconds after bot starts
  }).catch((error) => {
    console.error('❌ Lỗi khởi động bot:', error);
    console.error('📋 Chi tiết lỗi:', error.message);
    if (error.response) {
      console.error('📡 Response từ Telegram:', error.response);
    }
    process.exit(1);
  });
}).catch((error) => {
  console.error('❌ Lỗi kết nối với Telegram API:');
  console.error('📋 Chi tiết:', error.message);
  if (error.response) {
    console.error('📡 Response:', error.response);
  }
  console.error('💡 Kiểm tra lại BOT_TOKEN trong file .env');
  process.exit(1);
});

// Enable graceful stop
process.once('SIGINT', async () => {
  console.log('\n⏹️ Shutting down...');
  if (cronJob) {
    cronJob.stop();
  }
  if (mongoClient) {
    await mongoClient.close();
  }
  await bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', async () => {
  console.log('\n⏹️ Shutting down...');
  if (cronJob) {
    cronJob.stop();
  }
  if (mongoClient) {
    await mongoClient.close();
  }
  await bot.stop('SIGTERM');
  process.exit(0);
});

function saveSubscribers() {
  persistJsonToFile(SUBSCRIBERS_FILE, Array.from(subscribedUsers), 'danh sách người nhận thông báo');
}

function loadSubscribers() {
  const data = readJsonFromFile(SUBSCRIBERS_FILE, 'danh sách người nhận thông báo');
  if (Array.isArray(data)) {
    let restored = 0;
    data.forEach((id) => {
      if (!id) return;
      const idStr = String(id);
      subscribedUsers.add(idStr);
      restored += 1;
    });
    if (restored > 0) {
      console.log(`👥 Đã khôi phục ${restored} người dùng đăng ký nhận thông báo.`);
    } else {
      console.log('📂 Không có người dùng hợp lệ trong danh sách đăng ký.');
    }
  } else {
    console.log('📂 Chưa có người dùng nào đăng ký (lần đầu chạy).');
  }
}

function addSubscriber(chatId) {
  if (!chatId) return { added: false, reason: 'invalid' };
  const idStr = String(chatId);
  const isNew = !subscribedUsers.has(idStr);
  subscribedUsers.add(idStr);
  if (isNew) {
    saveSubscribers();
    console.log(`✅ Đã đăng ký người dùng ${idStr} nhận thông báo tự động.`);
  }
  return { added: isNew, reason: isNew ? 'added' : 'exists' };
}

const removeSubscriber = (chatId, reason) => {
  const idStr = String(chatId);
  if (subscribedUsers.has(idStr)) {
    subscribedUsers.delete(idStr);
    saveSubscribers();
    console.log(`✅ Đã xoá chat ID ${idStr} khỏi danh sách nhận thông báo. Lý do: ${reason}`);
  } else {
    console.log(`ℹ️ Chat ID ${idStr} không có trong danh sách nhận thông báo.`);
  }
};

function addAdmin(chatId) {
  if (!chatId) return { added: false, reason: 'invalid' };
  const idStr = String(chatId);
  if (adminUsers.has(idStr)) {
    return { added: false, reason: 'exists' };
  }
  adminUsers.add(idStr);
  saveAdmins();
  console.log(`✅ Đã thêm admin ${idStr}.`);
  return { added: true, reason: 'added' };
}

function removeAdmin(chatId) {
  if (!chatId) return { removed: false, reason: 'invalid' };
  const idStr = String(chatId);
  if (!adminUsers.has(idStr)) {
    return { removed: false, reason: 'not_found' };
  }
  adminUsers.delete(idStr);
  saveAdmins();
  console.log(`⚠️ Đã gỡ admin ${idStr}.`);
  return { removed: true, reason: 'removed' };
}

// Functions to manage CheckNotifiOrder chat IDs
function saveNotifiOrderChatIds() {
  persistJsonToFile(NOTIFI_ORDER_CHAT_IDS_FILE, Array.from(notifiOrderChatIds), 'danh sách chat ID nhận thông báo CheckNotifiOrder');
}

function loadNotifiOrderChatIds() {
  const data = readJsonFromFile(NOTIFI_ORDER_CHAT_IDS_FILE, 'danh sách chat ID nhận thông báo CheckNotifiOrder');
  if (Array.isArray(data)) {
    let restored = 0;
    data.forEach((id) => {
      if (!id) return;
      const idStr = String(id);
      if (!notifiOrderChatIds.has(idStr)) {
        notifiOrderChatIds.add(idStr);
        restored += 1;
      }
    });
    if (restored > 0) {
      console.log(`📱 Đã khôi phục ${restored} chat ID nhận thông báo CheckNotifiOrder.`);
    }
  } else {
    console.log('📂 Chưa có chat ID nào được cấu hình để nhận thông báo CheckNotifiOrder (lần đầu chạy).');
  }
}

function addNotifiOrderChatId(chatId) {
  if (!chatId) return { added: false, reason: 'invalid' };
  const idStr = String(chatId);
  if (notifiOrderChatIds.has(idStr)) {
    return { added: false, reason: 'exists' };
  }
  notifiOrderChatIds.add(idStr);
  saveNotifiOrderChatIds();
  console.log(`✅ Đã thêm chat ID ${idStr} vào danh sách nhận thông báo CheckNotifiOrder.`);
  return { added: true, reason: 'added' };
}

function removeNotifiOrderChatId(chatId) {
  if (!chatId) return { removed: false, reason: 'invalid' };
  const idStr = String(chatId);
  if (!notifiOrderChatIds.has(idStr)) {
    return { removed: false, reason: 'not_found' };
  }
  notifiOrderChatIds.delete(idStr);
  saveNotifiOrderChatIds();
  console.log(`⚠️ Đã gỡ chat ID ${idStr} khỏi danh sách nhận thông báo CheckNotifiOrder.`);
  return { removed: true, reason: 'removed' };
}