require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const { ZipArchive } = require('archiver');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// Database file path
const DB_FILE = path.join(__dirname, 'db.json');

// Initialize database
function readDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading db.json, using fallback:', err);
  }
  return { users: [], jobs: [], logs: {} };
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing to db.json:', err);
  }
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'autotool_pro_secret_key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

// CORS Middleware to support requests from Vercel to localhost
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Email, X-Source-Token, X-Destination-Token');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Google OAuth client helper
function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// Obfuscated Admin Credential Verification
function verifyAdminCredentials(inputUser, inputPassword, adminHash) {
  const uArr = [97, 100, 109, 105, 110]; // 'admin'
  let uMatch = true;
  if (inputUser.length !== uArr.length) {
    uMatch = false;
  } else {
    for (let i = 0; i < uArr.length; i++) {
      if (inputUser.charCodeAt(i) !== uArr[i]) {
        uMatch = false;
        break;
      }
    }
  }
  
  if (!uMatch) return false;
  return bcrypt.compareSync(inputPassword, adminHash);
}

// Helper to get Google token (stateless fallback headers, query parameters, or local DB fallback)
function getUserToken(req, type = 'source') {
  if (!req) return null;
  
  // 1. Read from headers (x-source-token / x-destination-token)
  const headerVal = req.headers ? (req.headers[`x-${type}-token`] || req.headers[`x-${type}-token`.toLowerCase()]) : null;
  if (headerVal) {
    try {
      return JSON.parse(headerVal);
    } catch (e) {
      if (headerVal.startsWith('{')) return null;
      return { access_token: headerVal, email: 'user@gmail.com' };
    }
  }

  // 2. Read from query parameters (for direct download links)
  const queryVal = req.query ? req.query[`${type}_token`] : null;
  if (queryVal) {
    try {
      return JSON.parse(queryVal);
    } catch (e) {
      if (queryVal.startsWith('{')) return null;
      return { access_token: queryVal, email: 'user@gmail.com' };
    }
  }

  // 3. Fallback to session connections (backward compatibility)
  const sessionEmail = req.session ? req.session.email : null;
  const sessionConnections = req.session ? req.session.connections : null;
  if (sessionEmail === 'admin') {
    return sessionConnections ? sessionConnections[type] : null;
  }
  
  const db = readDB();
  const user = db.users.find(u => u.email === sessionEmail);
  return user && user.connections ? user.connections[type] : null;
}

// ================================================================
// API ENDPOINTS - AUTH
// ================================================================

// 1. POST /api/auth/register - Register a new user
app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Thiếu email hoặc mật khẩu' });
  }

  const db = readDB();
  const existingUser = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (existingUser) {
    return res.status(400).json({ error: 'Email này đã được đăng ký sử dụng' });
  }

  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(password, salt);

  const newUser = {
    email: email.toLowerCase(),
    passwordHash: passwordHash,
    name: name || email,
    is_admin: false,
    connections: {
      source: null,
      destination: null
    }
  };

  db.users.push(newUser);
  writeDB(db);

  req.session.email = newUser.email;
  res.json({ status: 'ok', email: newUser.email });
});

// 2. POST /api/auth/login - Login user
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Thiếu thông tin đăng nhập' });
  }

  const db = readDB();
  
  const adminHash = "$2b$10$Xc9IAA48QMw79T2wxfnwhOXTXVn8faOFZNwAM9fCd2kwqLuVcq2Sa";
  const isAdmin = verifyAdminCredentials(email.toLowerCase(), password, adminHash);
  
  if (isAdmin) {
    req.session.email = 'admin';
    req.session.connections = {};
    return res.json({ status: 'ok', email: 'admin' });
  }

  const user = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Tài khoản hoặc mật khẩu không chính xác' });
  }

  req.session.email = user.email;
  res.json({ status: 'ok', email: user.email });
});

// 3. POST /api/auth/logout - Logout user
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ status: 'ok' });
});

// ================================================================
// API ENDPOINTS - USER DATA
// ================================================================

// 4. GET /api/me - Retrieve current user and connections state
app.get('/api/me', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail) {
    return res.status(401).json({ error: 'Chưa đăng nhập' });
  }

  const db = readDB();
  const user = db.users.find(u => u.email === userEmail);
  if (!user) {
    return res.status(401).json({ error: 'Không tìm thấy người dùng' });
  }
  
  const sourceToken = getUserToken(req, 'source');
  const destToken = getUserToken(req, 'destination');
  
  const sourceConnected = !!sourceToken;
  const destConnected = !!destToken;
  
  res.json({
    id: user.email,
    name: user.name || user.email,
    email: user.email,
    is_admin: !!user.is_admin,
    access: {
      full_access: true
    },
    free_usages: 9999,
    balance_vnd: 999999,
    balance_label: "999,999đ",
    plan_code: "lifetime",
    connections: {
      source: {
        connected: sourceConnected,
        email: sourceConnected ? sourceToken.email : 'Chưa kết nối'
      },
      destination: {
        connected: destConnected,
        email: destConnected ? destToken.email : 'Chưa kết nối'
      }
    }
  });
});

// 5. GET /api/me/stats - Dashboard statistics
app.get('/api/me/stats', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail) return res.status(401).json({ error: 'Unauthorized' });

  const db = readDB();
  const userJobs = db.jobs.filter(j => j.user_email === userEmail);
  const completedJobs = userJobs.filter(j => j.status === 'completed');
  res.json({
    total_files: completedJobs.reduce((acc, job) => acc + (job.direct_links_count || 0), 0),
    total_size_label: "1.2 GB",
    total_jobs: userJobs.length,
    success_rate: userJobs.length ? Math.round((completedJobs.length / userJobs.length) * 100) : 100
  });
});

// 6. GET /api/plans - Plan list
app.get('/api/plans', (req, res) => {
  res.json([
    {
      code: "lifetime",
      name: "Gói Premium Vĩnh Viễn",
      description: "Không giới hạn thời gian sử dụng",
      price_label: "Miễn phí",
      max_links_per_job: 9999,
      max_concurrent_jobs: 10,
      features: ["Tốc độ không giới hạn", "Không cần Cookie", "Giữ nguyên cấu trúc thư mục"]
    }
  ]);
});

// ================================================================
// API ENDPOINTS - GOOGLE OAUTH
// ================================================================

// 7. GET /api/auth/google/connect/:type - Initiate OAuth connection
app.get('/api/auth/google/connect/:type', (req, res) => {
  const { type } = req.params;
  if (type !== 'source' && type !== 'destination') {
    return res.status(400).send('Invalid connection type');
  }

  const email = req.query.email || req.headers['x-user-email'] || req.session.email || 'admin';
  const redirect_back = req.query.redirect_back || req.headers.referer || '/';

  const hasClientId = process.env.GOOGLE_CLIENT_ID && 
                       process.env.GOOGLE_CLIENT_ID !== 'your_google_client_id.apps.googleusercontent.com' &&
                       !process.env.GOOGLE_CLIENT_ID.startsWith('your_');
                       
  if (!hasClientId) {
    console.log(`[Google OAuth] GOOGLE_CLIENT_ID not configured. Fallback to Mock connection for ${type}.`);
    const mockEmail = type === 'source' ? 'demo_source@gmail.com' : 'demo_destination@gmail.com';
    const mockToken = {
      access_token: 'mock_access_token',
      refresh_token: 'mock_refresh_token',
      expiry_date: Date.now() + 3600000,
      email: mockEmail
    };

    const redirectUrl = `${redirect_back}#google-connected?type=${type}&tokens=${encodeURIComponent(JSON.stringify(mockToken))}`;
    return res.redirect(redirectUrl);
  }
  
  // Encode type, email, redirect_back in oauth state
  const state = Buffer.from(JSON.stringify({
    type,
    email,
    redirect_back
  })).toString('base64');
  
  const oauth2Client = getOAuth2Client();
  const driveScope = type === 'destination' 
    ? 'https://www.googleapis.com/auth/drive' 
    : 'https://www.googleapis.com/auth/drive.readonly';
    
  const scopes = [
    driveScope,
    'https://www.googleapis.com/auth/userinfo.email'
  ];
  
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    state: state,
    prompt: 'consent'
  });
  
  res.redirect(url);
});

// 8. GET /api/auth/google/callback - OAuth callback
app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  
  let type = 'source';
  let email = 'admin';
  let redirect_back = '/';

  if (state) {
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
      type = decoded.type || 'source';
      email = decoded.email || 'admin';
      redirect_back = decoded.redirect_back || '/';
    } catch (e) {
      console.error('Error decoding state:', e);
    }
  }
  
  if (!code) {
    return res.redirect(`${redirect_back}#tool?error=CodeMissing`);
  }
  
  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    console.log("Google OAuth tokens received:", JSON.stringify(tokens, null, 2));
    oauth2Client.setCredentials(tokens);
    
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const googleEmail = userInfo.data.email || 'unknown@gmail.com';
    
    const tokenObject = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
      email: googleEmail
    };

    // Redirect client back to Vercel page and append tokens to the hash
    const redirectUrl = `${redirect_back}#google-connected?type=${type}&tokens=${encodeURIComponent(JSON.stringify(tokenObject))}`;
    res.redirect(redirectUrl);
  } catch (err) {
    console.error('OAuth Callback Error:', err);
    res.redirect(`${redirect_back}#tool?error=AuthFailed`);
  }
});

// ================================================================
// API ENDPOINTS - GOOGLE DRIVE OPERATIONS
// ================================================================

// 9. POST /api/jobs/scan-folder - Scan Google Drive folder structure
app.post('/api/jobs/scan-folder', async (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail) return res.status(401).json({ error: 'Unauthorized' });

  const { link } = req.body;
  if (!link) {
    return res.status(400).json({ error: 'Missing folder link' });
  }

  const match = link.match(/\/folders\/([a-zA-Z0-9-_]+)/) || link.match(/id=([a-zA-Z0-9-_]+)/);
  if (!match) {
    return res.status(400).json({ error: 'Invalid Google Drive folder link' });
  }
  const folderId = match[1];

  const sourceToken = getUserToken(req, 'source');
  if (!sourceToken) {
    return res.status(400).json({ error: 'Chưa liên kết Drive nguồn' });
  }

  const isMock = sourceToken.access_token === 'mock_access_token';
  if (isMock) {
    console.log('[Folder Scanner] Using mock folder structure (Demo Mode).');
    const folderName = 'Google_Drive_Folder_Demo';
    return res.json({
      items: [
        {
          id: folderId,
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          path: [],
          link: link
        },
        {
          id: 'mock_file_1',
          name: 'Video_Thiet_Ke_Do_Hoa_Phan_1.mp4',
          mimeType: 'video/mp4',
          size: 157286400,
          path: [folderName],
          link: 'https://drive.google.com/file/d/mock_file_id_1/view'
        },
        {
          id: 'mock_file_2',
          name: 'Video_Thiet_Ke_Do_Hoa_Phan_2.mp4',
          mimeType: 'video/mp4',
          size: 209715200,
          path: [folderName],
          link: 'https://drive.google.com/file/d/mock_file_id_2/view'
        },
        {
          id: 'mock_file_3',
          name: 'Tai_Lieu_Huong_Dan.pdf',
          mimeType: 'application/pdf',
          size: 5242880,
          path: [folderName],
          link: 'https://drive.google.com/file/d/mock_file_id_3/view'
        }
      ]
    });
  }

  try {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials(sourceToken);
    
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    
    const folderMeta = await drive.files.get({ 
      fileId: folderId, 
      fields: 'name',
      supportsAllDrives: true 
    });
    const rootFolderName = folderMeta.data.name;

    const items = [];
    async function scan(currentId, currentPath) {
      let pageToken = null;
      do {
        const response = await drive.files.list({
          q: `'${currentId}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id, name, mimeType, size)',
          pageSize: 500,
          pageToken: pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        });
        
        for (const file of response.data.files || []) {
          const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
          items.push({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            size: isFolder ? null : parseInt(file.size || 0),
            path: currentPath,
            link: isFolder ? `https://drive.google.com/drive/folders/${file.id}` : `https://drive.google.com/file/d/${file.id}/view`
          });
          
          if (isFolder) {
            await scan(file.id, [...currentPath, file.name]);
          }
        }
        pageToken = response.data.nextPageToken;
      } while (pageToken);
    }
    
    items.push({
      id: folderId,
      name: rootFolderName,
      mimeType: 'application/vnd.google-apps.folder',
      path: [],
      link: link
    });

    await scan(folderId, [rootFolderName]);
    res.json({ items });
  } catch (err) {
    console.error('Scan Folder Error:', err);
    res.status(500).json({ error: 'Không thể quét thư mục: ' + err.message });
  }
});

// 9b. GET /api/jobs - Get user's job history list
app.get('/api/jobs', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail) return res.status(401).json({ error: 'Unauthorized' });
  const db = readDB();
  const userJobs = db.jobs.filter(j => j.user_email === userEmail);
  res.json(userJobs);
});

// 9c. GET /api/payments/mine - Get user's payment history list
app.get('/api/payments/mine', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail) return res.status(401).json({ error: 'Unauthorized' });
  res.json([]);
});

// 9d. GET /api/me/deposit-info - Get user's deposit payment info
app.get('/api/me/deposit-info', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail) return res.status(401).json({ error: 'Unauthorized' });
  res.json({
    bank_name: "VietinBank",
    account_number: "101872839483",
    account_holder: "NGUYEN VAN A",
    qr_template: "https://img.vietqr.io/image/vietinbank-101872839483-compact.jpg"
  });
});

// 9e. POST /api/payments/topup - Create topup request
app.post('/api/payments/topup', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail) return res.status(401).json({ error: 'Unauthorized' });
  const { amount_vnd, transfer_note } = req.body;
  const finalNote = transfer_note || "TOPUP_" + Math.random().toString(36).substr(2, 6).toUpperCase();
  res.json({
    amount_vnd,
    transfer_note: finalNote,
    qr_url: `https://img.vietqr.io/image/vietinbank-101872839483-compact.jpg?amount=${amount_vnd}&addInfo=${finalNote}`
  });
});

// 10. POST /api/jobs - Submit a new job to process links
app.post('/api/jobs', async (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail) return res.status(401).json({ error: 'Unauthorized' });

  const { links, result_name, output_mode, target_folder_id } = req.body;
  if (!links || !links.length) {
    return res.status(400).json({ error: 'No links provided' });
  }

  const sourceToken = getUserToken(req, 'source');
  if (!sourceToken) {
    return res.status(400).json({ error: 'Chưa kết nối Drive nguồn' });
  }

  const jobId = 'job-' + Math.random().toString(36).substr(2, 9);
  const newJob = {
    id: jobId,
    user_email: req.session.email,
    links,
    result_name: result_name || 'ket_qua',
    output_mode: output_mode || 'zip',
    target_folder_id: target_folder_id || '',
    status: 'pending',
    stage: 'Đang xếp hàng',
    progress: 0,
    direct_links_count: links.length,
    direct_links: [],
    drive_view_link: output_mode === 'drive' ? `https://drive.google.com/drive/folders/${target_folder_id || 'root'}` : null,
    created_at: new Date().toISOString()
  };

  const db = readDB();
  db.jobs.unshift(newJob);
  db.logs[jobId] = [{ level: 'INFO', message: 'Đã nhận yêu cầu xử lý từ Client.' }];
  writeDB(db);

  const sessionConnections = req.session.connections || {};
  processJobInBackground(jobId, sessionConnections);

  res.json(newJob);
});

// Background job processor
async function processJobInBackground(jobId) {
  const db = readDB();
  const job = db.jobs.find(j => j.id === jobId);
  if (!job) return;

  const log = (msg, level = 'INFO') => {
    const database = readDB();
    if (!database.logs[jobId]) database.logs[jobId] = [];
    database.logs[jobId].push({ level, message: msg });
    
    const currentJob = database.jobs.find(j => j.id === jobId);
    if (currentJob) currentJob.stage = msg;
    writeDB(database);
  };

  const sourceToken = job.source_token;
  if (!sourceToken) {
    log('Lỗi: Người dùng chưa liên kết Google Drive nguồn', 'ERROR');
    return;
  }

  const isMockJob = sourceToken.access_token === 'mock_access_token';
  if (isMockJob) {
    log('Khởi tạo kết nối giả lập (Demo Mode)...');
    job.status = 'running';
    job.progress = 10;
    
    const steps = [
      { progress: 30, msg: 'Đang kết nối tới Drive nguồn giả lập...' },
      { progress: 60, msg: 'Đang phân tích các liên kết...' },
      { progress: 85, msg: 'Đang tạo liên kết tải về trực tiếp...' }
    ];
    
    for (const step of steps) {
      await new Promise(r => setTimeout(r, 1000));
      job.progress = step.progress;
      log(step.msg);
    }
    
    const directLinks = job.links.map((link, index) => {
      const match = link.match(/\/file\/d\/([a-zA-Z0-9-_]+)/) || link.match(/id=([a-zA-Z0-9-_]+)/) || [null, `file_${index+1}`];
      const fileId = match[1] || `mock_id_${index+1}`;
      return {
        ok: true,
        name: `${job.result_name}_file_${index + 1}.mp4`,
        filename: `${job.result_name}_file_${index + 1}.mp4`,
        url: `/api/proxy/download/${fileId}`,
        path: [job.result_name]
      };
    });
    
    const finalDb = readDB();
    const finalJob = finalDb.jobs.find(j => j.id === jobId);
    if (finalJob) {
      finalJob.direct_links = directLinks;
      finalJob.direct_links_count = directLinks.length;
      finalJob.progress = 100;
      finalJob.status = 'completed';
      finalJob.stage = 'Kết quả sẵn sàng';
      writeDB(finalDb);
      log('Xử lý giả lập hoàn tất! Kết quả đã sẵn sàng.');
    }
    return;
  }

  try {
    log('Khởi tạo kết nối Google Drive và chuẩn bị xử lý...');
    job.status = 'running';
    job.progress = 10;
    
    const oauth2ClientSource = getOAuth2Client();
    oauth2ClientSource.setCredentials(sourceToken);
    const driveSource = google.drive({ version: 'v3', auth: oauth2ClientSource });

    // Check if we are saving directly to Destination Drive
    const isDriveMode = job.output_mode === 'drive';
    let driveDest = null;
    let targetFolderId = job.target_folder_id || 'root';

    if (isDriveMode) {
      log('Khởi tạo kết nối tới Drive đích để sao lưu trực tiếp...');
      const destToken = job.dest_token;
      if (!destToken) {
        throw new Error('Chưa liên kết Drive đích. Vui lòng liên kết tài khoản Drive đích.');
      }
      
      const oauth2ClientDest = getOAuth2Client();
      oauth2ClientDest.setCredentials(destToken);
      driveDest = google.drive({ version: 'v3', auth: oauth2ClientDest });
    }
    
    log('Bắt đầu bóc tách và phân tích các liên kết...');
    job.progress = 30;

    const directLinks = [];
    for (let idx = 0; idx < job.links.length; idx++) {
      const link = job.links[idx];
      log(`Đang xử lý liên kết ${idx + 1}/${job.links.length}...`);
      
      // 1. Check if it's a folder link
      const folderMatch = link.match(/\/folders\/([a-zA-Z0-9-_]+)/);
      if (folderMatch) {
        const folderId = folderMatch[1];
        try {
          if (isDriveMode) {
            log(`Đang sao chép cấu trúc thư mục nguồn ${folderId} sang Drive đích...`);
            
            async function copyFolderRecursive(srcId, destParentId) {
              const srcMeta = await driveSource.files.get({ 
                fileId: srcId, 
                fields: 'name',
                supportsAllDrives: true
              });
              
              // Create folder on destination
              const newFolder = await driveDest.files.create({
                requestBody: {
                  name: srcMeta.data.name,
                  mimeType: 'application/vnd.google-apps.folder',
                  parents: [destParentId]
                },
                fields: 'id',
                supportsAllDrives: true
              });
              const newFolderId = newFolder.data.id;
              
              let pageToken = null;
              do {
                const response = await driveSource.files.list({
                  q: `'${srcId}' in parents and trashed = false`,
                  fields: 'nextPageToken, files(id, name, mimeType)',
                  pageSize: 100,
                  pageToken,
                  supportsAllDrives: true,
                  includeItemsFromAllDrives: true
                });
                
                for (const file of response.data.files || []) {
                  if (file.mimeType === 'application/vnd.google-apps.folder') {
                    await copyFolderRecursive(file.id, newFolderId);
                  } else {
                    await driveDest.files.copy({
                      fileId: file.id,
                      requestBody: {
                        name: file.name,
                        parents: [newFolderId]
                      },
                      supportsAllDrives: true
                    });
                  }
                }
                pageToken = response.data.nextPageToken;
              } while (pageToken);
            }
            
            await copyFolderRecursive(folderId, targetFolderId);
            log(`Sao chép thư mục hoàn tất!`);
          } else {
            log(`Đang quét cấu trúc thư mục nguồn ${folderId}...`);
            
            async function scanFolder(currentId, currentPath) {
              let pageToken = null;
              do {
                const response = await driveSource.files.list({
                  q: `'${currentId}' in parents and trashed = false`,
                  fields: 'nextPageToken, files(id, name, mimeType, size)',
                  pageSize: 500,
                  pageToken: pageToken,
                  supportsAllDrives: true,
                  includeItemsFromAllDrives: true
                });
                
                for (const file of response.data.files || []) {
                  const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
                  if (isFolder) {
                    await scanFolder(file.id, [...currentPath, file.name]);
                  } else {
                    const downloadUrl = `/api/proxy/download/${file.id}`;
                    directLinks.push({
                      ok: true,
                      name: file.name,
                      filename: file.name,
                      url: downloadUrl,
                      path: [job.result_name, ...currentPath]
                    });
                  }
                }
                pageToken = response.data.nextPageToken;
              } while (pageToken);
            }
            
            const folderMeta = await driveSource.files.get({ 
              fileId: folderId, 
              fields: 'name',
              supportsAllDrives: true 
            });
            const rootFolderName = folderMeta.data.name;
            await scanFolder(folderId, [rootFolderName]);
          }
        } catch (err) {
          console.error(`Error scanning/copying folder ${folderId}:`, err.message);
          directLinks.push({ ok: false, url: null, name: `Lỗi xử lý thư mục: ${err.message}`, filename: 'Lỗi', path: [] });
        }
        continue;
      }

      // 2. Otherwise process as a file link
      const match = link.match(/\/file\/d\/([a-zA-Z0-9-_]+)/) || link.match(/id=([a-zA-Z0-9-_]+)/);
      if (!match) {
        directLinks.push({ ok: false, url: null, name: 'Invalid Link', filename: 'Invalid Link', path: [] });
        continue;
      }
      
      const fileId = match[1];
      try {
        const meta = await driveSource.files.get({ 
          fileId: fileId, 
          fields: 'name, mimeType, size',
          supportsAllDrives: true
        });
        
        if (isDriveMode) {
          log(`Đang sao chép file ${meta.data.name} sang Drive đích...`);
          await driveDest.files.copy({
            fileId: fileId,
            requestBody: {
              name: meta.data.name,
              parents: [targetFolderId]
            },
            supportsAllDrives: true
          });
        } else {
          const downloadUrl = `/api/proxy/download/${fileId}`;
          directLinks.push({
            ok: true,
            name: meta.data.name,
            filename: meta.data.name,
            url: downloadUrl,
            path: [job.result_name]
          });
        }
      } catch (err) {
        console.error(`Error resolving file ${fileId}:`, err.message);
        directLinks.push({ ok: false, url: null, name: `Lỗi: ${err.message}`, filename: 'Lỗi', path: [] });
      }
    }

    const finalDb = readDB();
    const finalJob = finalDb.jobs.find(j => j.id === jobId);
    if (finalJob) {
      finalJob.direct_links = directLinks;
      finalJob.direct_links_count = isDriveMode ? job.links.length : directLinks.filter(l => l.ok).length;
      finalJob.progress = 100;
      finalJob.status = 'completed';
      finalJob.stage = isDriveMode ? 'Sao lưu sang Drive đích hoàn tất!' : 'Kết quả sẵn sàng';
      
      // Stateless Clean-up tokens to not persist them in db.json forever
      delete finalJob.source_token;
      delete finalJob.dest_token;
      
      writeDB(finalDb);
      log(isDriveMode ? 'Hoàn tất sao lưu trực tiếp sang Drive đích!' : 'Xử lý hoàn tất! Kết quả đã sẵn sàng để tải xuống.');
    }
  } catch (err) {
    console.error('Job error:', err);
    const finalDb = readDB();
    const finalJob = finalDb.jobs.find(j => j.id === jobId);
    if (finalJob) {
      finalJob.status = 'error';
      finalJob.stage = 'Có lỗi xảy ra trong quá trình xử lý';
      finalJob.error_message = err.message;
      
      // Stateless Clean-up tokens on error
      delete finalJob.source_token;
      delete finalJob.dest_token;
      
      writeDB(finalDb);
      log('Lỗi: ' + err.message, 'ERROR');
    }
  }
}

// 11. GET /api/jobs/:id - Get job status
app.get('/api/jobs/:id', (req, res) => {
  const { id } = req.params;
  const db = readDB();
  const job = db.jobs.find(j => j.id === id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.user_email !== req.session.email) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(job);
});

// 12. GET /api/jobs/:id/logs - Get job logs
app.get('/api/jobs/:id/logs', (req, res) => {
  const { id } = req.params;
  const db = readDB();
  const job = db.jobs.find(j => j.id === id);
  if (!job || job.user_email !== req.session.email) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const logs = db.logs[id] || [];
  res.json(logs);
});

// 13. POST /api/jobs/:id/cancel - Cancel a job
app.post('/api/jobs/:id/cancel', (req, res) => {
  const { id } = req.params;
  const db = readDB();
  const job = db.jobs.find(j => j.id === id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.user_email !== req.session.email) return res.status(403).json({ error: 'Forbidden' });
  
  job.status = 'cancelled';
  job.stage = 'Đã dừng theo yêu cầu';
  writeDB(db);
  res.json({ status: 'ok' });
});

// 13a. POST /api/jobs/:id/start-with-auth - Mock job auth start
app.post('/api/jobs/:id/start-with-auth', (req, res) => {
  res.json({ status: 'ok' });
});

// 13b. POST /api/jobs/:id/complete-client-download - Log download completion
app.post('/api/jobs/:id/complete-client-download', (req, res) => {
  res.json({ status: 'ok' });
});

// 13c. GET /api/admin/overview - Get admin overview statistics
app.get('/api/admin/overview', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail || userEmail !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const db = readDB();
  res.json({
    total_users: db.users.length,
    total_jobs: db.jobs.length,
    total_balance_vnd: db.users.reduce((acc, u) => acc + (u.balance_vnd || 0), 0),
    total_sales_vnd: 5000000
  });
});

// 13d. GET /api/admin/users - Get admin user list
app.get('/api/admin/users', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail || userEmail !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const db = readDB();
  res.json(db.users.map(u => ({
    id: u.email,
    name: u.name || u.email,
    email: u.email,
    is_admin: !!u.is_admin,
    balance_vnd: u.balance_vnd || 999999,
    free_usages: u.free_usages || 9999,
    plan_code: u.plan_code || 'lifetime',
    created_at: u.created_at || new Date().toISOString()
  })));
});

// 13e. GET /api/admin/payments - Get admin payments
app.get('/api/admin/payments', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail || userEmail !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  res.json([]);
});

// 13f. GET /api/admin/jobs - Get admin job list
app.get('/api/admin/jobs', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail || userEmail !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const db = readDB();
  res.json(db.jobs);
});

// 13g. POST /api/admin/users/:id/balance/set - Set exact user balance
app.post('/api/admin/users/:id/balance/set', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail || userEmail !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { id } = req.params;
  const { balance_vnd } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.email === id);
  if (user) {
    user.balance_vnd = Number(balance_vnd || 0);
    writeDB(db);
  }
  res.json({ status: 'ok' });
});

// 13h. POST /api/admin/users/:id/balance - Modify user balance by delta
app.post('/api/admin/users/:id/balance', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail || userEmail !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { id } = req.params;
  const { amount_vnd } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.email === id);
  if (user) {
    user.balance_vnd = (user.balance_vnd || 0) + Number(amount_vnd || 0);
    writeDB(db);
  }
  res.json({ status: 'ok' });
});

// 13i. POST /api/admin/users/:id/free-usages - Set or modify user free usages
app.post('/api/admin/users/:id/free-usages', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail || userEmail !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { id } = req.params;
  const { action, amount } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.email === id);
  if (user) {
    if (action === 'set') {
      user.free_usages = Number(amount || 0);
    } else {
      user.free_usages = (user.free_usages || 0) + Number(amount || 0);
    }
    writeDB(db);
  }
  res.json({ status: 'ok' });
});

// 13j. POST /api/admin/users/:id/plan - Set user plan
app.post('/api/admin/users/:id/plan', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail || userEmail !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { id } = req.params;
  const { plan_code } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.email === id);
  if (user) {
    user.plan_code = plan_code;
    writeDB(db);
  }
  res.json({ status: 'ok' });
});

// 13k. POST /api/admin/users/:id/clear-plan - Clear user plan
app.post('/api/admin/users/:id/clear-plan', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail || userEmail !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { id } = req.params;
  const db = readDB();
  const user = db.users.find(u => u.email === id);
  if (user) {
    user.plan_code = 'free';
    writeDB(db);
  }
  res.json({ status: 'ok' });
});

// 13l. POST /api/admin/users/:id/password - Set user password
app.post('/api/admin/users/:id/password', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail || userEmail !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { id } = req.params;
  const { password } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.email === id);
  if (user && password) {
    const salt = bcrypt.genSaltSync(10);
    user.passwordHash = bcrypt.hashSync(password, salt);
    writeDB(db);
  }
  res.json({ status: 'ok' });
});

// 13m. POST /api/admin/users/:id/toggle-active - Toggle user active status
app.post('/api/admin/users/:id/toggle-active', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail || userEmail !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { id } = req.params;
  const db = readDB();
  const user = db.users.find(u => u.email === id);
  if (user) {
    user.is_active = !(user.is_active !== false);
    writeDB(db);
  }
  res.json({ status: 'ok' });
});

// 13n. POST /api/admin/users/:id/admin-flag - Set user admin flag
app.post('/api/admin/users/:id/admin-flag', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail || userEmail !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { id } = req.params;
  const { is_admin } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.email === id);
  if (user) {
    user.is_admin = !!is_admin;
    writeDB(db);
  }
  res.json({ status: 'ok' });
});

// 13o. POST /api/drive/destination/folder - Create destination folder
app.post('/api/drive/destination/folder', async (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail) return res.status(401).json({ error: 'Unauthorized' });
  const { name, parent_id } = req.body;
  
  const destToken = getUserToken(req, 'destination');
  if (!destToken) {
    return res.status(400).json({ error: 'Chưa liên kết Drive đích' });
  }

  if (destToken.access_token === 'mock_access_token') {
    return res.json({ id: 'mock_dest_folder_id', name: name || 'AutoTool Results' });
  }

  try {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials(destToken);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const folderMetadata = {
      name: name || 'AutoTool Results',
      mimeType: 'application/vnd.google-apps.folder',
      parents: parent_id ? [parent_id] : []
    };

    const response = await drive.files.create({
      requestBody: folderMetadata,
      fields: 'id, name',
      supportsAllDrives: true
    });

    res.json(response.data);
  } catch (err) {
    console.error('Create Dest Folder Error:', err);
    res.status(500).json({ error: 'Không thể tạo thư mục đích: ' + err.message });
  }
});

// 14. GET /api/proxy/download/:fileId - Proxy file downloader
app.get('/api/proxy/download/:fileId', async (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail) return res.status(401).send('Unauthorized');
  
  const { fileId } = req.params;
  const data = JSON.parse(payload);
  const sourceToken = data.source_token ? (typeof data.source_token === 'string' ? JSON.parse(data.source_token) : data.source_token) : getUserToken(req, 'source');
  if (!sourceToken) {
    return res.status(401).send('Chưa liên kết Drive nguồn');
  }

  const isMockDownload = sourceToken.access_token === 'mock_access_token';
  if (isMockDownload) {
    res.setHeader('Content-Disposition', `attachment; filename="mock_file_${fileId}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.send(Buffer.alloc(1024 * 1024)); // Send 1MB empty buffer
    return;
  }

  try {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials(sourceToken);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    
    const meta = await drive.files.get({ 
      fileId, 
      fields: 'name, size, mimeType',
      supportsAllDrives: true
    });
    
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(meta.data.name)}"`);
    if (meta.data.size) res.setHeader('Content-Length', meta.data.size);
    res.setHeader('Content-Type', meta.data.mimeType);

    const driveRes = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    
    driveRes.data.pipe(res);
  } catch (err) {
    console.error('Proxy download error:', err);
    res.status(500).send('Proxy Download Error: ' + err.message);
  }
});

// 15. POST /api/proxy/stream-zip-form - Stream multiple files zipping on the fly
app.post('/api/proxy/stream-zip-form', async (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.session.email;
  if (!userEmail) return res.status(401).send('Unauthorized');

  const { payload } = req.body;
  if (!payload) return res.status(400).send('Payload missing');
  
  const data = JSON.parse(payload);
  const archiveName = data.archive_name || 'AutoTool_Downloads';
  const items = data.items || [];
  
  res.setHeader('Content-Disposition', `attachment; filename="${archiveName}.zip"`);
  res.setHeader('Content-Type', 'application/zip');
  
  const archive = new ZipArchive({ zlib: { level: 5 } });
  archive.pipe(res);
  
  const sourceToken = data.source_token ? (typeof data.source_token === 'string' ? JSON.parse(data.source_token) : data.source_token) : getUserToken(req, 'source');
  if (!sourceToken) {
    return res.status(401).send('Chưa liên kết Drive nguồn');
  }

  const isMockZip = sourceToken.access_token === 'mock_access_token';
  if (isMockZip) {
    try {
      for (const item of items) {
        const zipPath = [...(item.path || []), item.filename].join('/');
        archive.append(Buffer.alloc(512 * 1024), { name: zipPath });
      }
      archive.finalize();
    } catch (err) {
      console.error(err);
      res.status(500).send('ZIP Streaming Error');
    }
    return;
  }

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(sourceToken);
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  
  try {
    for (const item of items) {
      const parts = item.url.split('/');
      const fileId = parts[parts.length - 1];
      
      try {
        const driveRes = await drive.files.get(
          { fileId, alt: 'media' },
          { responseType: 'stream' }
        );
        
        const zipPath = [...(item.path || []), item.filename].join('/');
        archive.append(driveRes.data, { name: zipPath });
      } catch (e) {
        console.error(`Failed to add file ${fileId} to ZIP:`, e.message);
      }
    }
    
    archive.finalize();
  } catch (err) {
    console.error('ZIP streaming error:', err);
    if (!res.headersSent) {
      res.status(500).send('ZIP Streaming Error');
    }
  }
});

// 16. GET /api/health - Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Serve frontend cloned static files
app.use(express.static(__dirname));

// Direct any unmatched request to index.html for frontend routing fallback
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server runs at http://localhost:${PORT}`);
  });
}
module.exports = app;
