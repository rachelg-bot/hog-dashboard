require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const TABS = ['HOODIES', 'PANTS', 'SET', 'TEE', 'SHORTS'];
const SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL'];

function getAuth() {
  // Support credentials from env var (Vercel) or local file
  if (process.env.GOOGLE_CREDENTIALS) {
    const creds = JSON.parse(
      Buffer.from(process.env.GOOGLE_CREDENTIALS, 'base64').toString('utf8')
    );
    return new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  return new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheetsClient() {
  const auth = getAuth();
  return google.sheets({ version: 'v4', auth });
}

// Parse a tab's raw row data into structured products
function parseTab(rows) {
  if (!rows || rows.length < 2) return [];
  const products = [];

  // Row 0 = headers, then pairs: inventory row + orders row
  let i = 1;
  while (i < rows.length) {
    const invRow = rows[i] || [];
    const ordRow = rows[i + 1] || [];
    const name = (invRow[0] || '').trim();

    if (!name) {
      i += 2;
      continue;
    }

    const sizes = {};
    for (let s = 0; s < SIZES.length; s++) {
      const col = s + 1; // column index (A=0, B=1, ...)
      const qty = parseInt(invRow[col]) || 0;
      const orders = (ordRow[col] || '').trim();
      sizes[SIZES[s]] = { qty, orders };
    }

    products.push({
      name,
      sheetRow: i + 1, // 1-indexed row number in sheet (inventory row)
      sizes,
    });

    i += 2;
  }
  return products;
}

// GET /api/inventory — return all tabs
app.get('/api/inventory', async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    const result = {};

    for (const tab of TABS) {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${tab}!A:H`,
      });
      result[tab] = parseTab(response.data.values || []);
    }

    res.json({ ok: true, data: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/log-order
// Body: { tab, sheetRow, size, orderNumber }
// sheetRow = 1-indexed inventory row in sheet
// size = one of SIZES
app.post('/api/log-order', async (req, res) => {
  const { tab, sheetRow, size, orderNumber } = req.body;

  if (!tab || !sheetRow || !size || !orderNumber) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }
  if (!TABS.includes(tab)) {
    return res.status(400).json({ ok: false, error: 'Invalid tab' });
  }
  if (!SIZES.includes(size)) {
    return res.status(400).json({ ok: false, error: 'Invalid size' });
  }

  const sizeColIndex = SIZES.indexOf(size); // 0-based among sizes
  const colLetter = String.fromCharCode(66 + sizeColIndex); // B=66, C=67, ...

  const invRowNum = sheetRow;        // inventory row (1-indexed)
  const ordRowNum = sheetRow + 1;    // orders row

  try {
    const sheets = await getSheetsClient();

    // Read current values for both rows
    const readRes = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: SPREADSHEET_ID,
      ranges: [
        `${tab}!${colLetter}${invRowNum}`,
        `${tab}!${colLetter}${ordRowNum}`,
      ],
    });

    const invCell = readRes.data.valueRanges[0].values?.[0]?.[0] ?? '0';
    const ordCell = readRes.data.valueRanges[1].values?.[0]?.[0] ?? '';

    const currentQty = parseInt(invCell) || 0;
    if (currentQty <= 0) {
      return res.status(400).json({ ok: false, error: 'No stock remaining for this size' });
    }

    const newQty = currentQty - 1;
    const newOrders = ordCell
      ? `${ordCell} ${orderNumber}`
      : orderNumber;

    // Write both cells back
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          {
            range: `${tab}!${colLetter}${invRowNum}`,
            values: [[newQty]],
          },
          {
            range: `${tab}!${colLetter}${ordRowNum}`,
            values: [[newOrders]],
          },
        ],
      },
    });

    res.json({ ok: true, newQty, newOrders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`HOG Dashboard running on http://localhost:${PORT}`));
}

module.exports = app;
