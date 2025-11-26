require('dotenv').config();
const MB = require('./mbbank/dist/index');

const formatDate = (date) => {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
};

const getDateRange = () => {
  // Create dates using Vietnam time zone (UTC+7)
  const vietnamOffset = 7 * 60 * 60 * 1000; // 7 hours in milliseconds
  const utcTime = new Date().getTime();
  const vietnamTime = new Date(utcTime + vietnamOffset);
  
  const today = new Date(vietnamTime);
  const threeDaysAgo = new Date(vietnamTime);
  threeDaysAgo.setDate(today.getDate() - 2);
  
  return {
    fromDate: formatDate(threeDaysAgo),
    toDate: formatDate(today),
  };
};

const run = async () => {
  // Đọc thông tin từ biến môi trường
  const username = process.env.MB_USERNAME;
  const password = process.env.MB_PASSWORD;
  const accountNumber = process.env.MB_BANK_CARD_DEFAULT;

  if (!username || !password) {
    console.error('Lỗi: Vui lòng cung cấp MB_USERNAME và MB_PASSWORD trong file .env');
    process.exit(1);
  }

  const mb = new MB({
    username: username,
    password: password,
  });

  try {
    await mb.login();
    const balance = await mb.getBalance();
    console.log('Account Balance:', balance);

    const { fromDate, toDate } = getDateRange();

    const history = await mb.getTransactionsHistory({
      accountNumber: accountNumber || "96999898989999", // Sử dụng MB_BANK_CARD_DEFAULT nếu có
      fromDate,
      toDate,
    });

    console.log('Transaction History:', history);

  } catch (error) {
    console.error('Failed to get balance or transactions:', error.message || error);
  }
};

run();
