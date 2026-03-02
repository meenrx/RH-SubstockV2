import express from 'express';
import { createServer as createViteServer } from 'vite';
import { initDatabase, db } from './server/db';

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Initialize DB
  initDatabase();

  app.use(express.json());

  // API Routes
  
  // Get Dashboard Stats
  app.get('/api/dashboard', (req, res) => {
    try {
      // Total Stock Value
      const valueStmt = db.prepare(`
        SELECT SUM(qty * price_per_unit) as total_value 
        FROM transactions 
      `);
      // Note: This is a simplified calculation. Real stock needs to sum IN - OUT.
      // Let's do a proper stock calculation per lot first.
      
      const stock = getStockSummary();
      const totalValue = stock.reduce((sum, item) => sum + (item.qty * item.price), 0);
      const totalItems = stock.reduce((sum, item) => sum + item.qty, 0);
      
      const today = new Date().toISOString().split('T')[0];
      const threeMonthsFromNow = new Date(new Date().setMonth(new Date().getMonth() + 3)).toISOString().split('T')[0];
      const sixMonthsFromNow = new Date(new Date().setMonth(new Date().getMonth() + 6)).toISOString().split('T')[0];

      const expired = stock.filter(i => i.exp_date && i.exp_date < today && i.qty > 0);
      const nearExp3 = stock.filter(i => i.exp_date && i.exp_date >= today && i.exp_date < threeMonthsFromNow && i.qty > 0);
      const nearExp3to6 = stock.filter(i => i.exp_date && i.exp_date >= threeMonthsFromNow && i.exp_date < sixMonthsFromNow && i.qty > 0);
      const lowStock = stock.filter(i => i.qty < i.min_stock);
      const outOfStock = stock.filter(i => i.qty <= 0);

      res.json({
        totalValue,
        totalItems,
        expiredCount: expired.length,
        nearExp3Count: nearExp3.length,
        nearExp3to6Count: nearExp3to6.length,
        lowStockCount: lowStock.length,
        outOfStockCount: outOfStock.length,
        stockData: stock
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // Get Transactions
  app.get('/api/transactions', (req, res) => {
    const stmt = db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT 100');
    const transactions = stmt.all();
    res.json(transactions);
  });

  // Create Transaction
  app.post('/api/transactions', (req, res) => {
    const { date, drug_id, drug_name, lot_no, exp_date, pack_size, qty, price_per_unit, user, type, reason } = req.body;
    
    // Generate Disp No (Year + Running)
    const year = new Date().getFullYear() + 543; // Buddhist Era
    const shortYear = year.toString().slice(-2);
    
    const countStmt = db.prepare("SELECT COUNT(*) as count FROM transactions WHERE disp_no LIKE ?");
    const count = countStmt.get(`${shortYear}%`) as { count: number };
    const running = (count.count + 1).toString().padStart(3, '0');
    const disp_no = `${shortYear}${running}`;

    // Adjust quantity based on type
    let finalQty = parseInt(qty);
    if (type === 'OUT') {
      finalQty = -Math.abs(finalQty);
    }
    // For ADJUST, we usually calculate the difference, but here let's assume the UI sends the difference or we handle it differently.
    // The prompt says "Adjust: before, after, diff". 
    // If the UI sends the 'diff' as qty, we can just insert it.
    
    const stmt = db.prepare(`
      INSERT INTO transactions (date, disp_no, drug_id, drug_name, lot_no, exp_date, pack_size, qty, price_per_unit, user, transaction_type, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      const info = stmt.run(date, disp_no, drug_id, drug_name, lot_no, exp_date, pack_size, finalQty, price_per_unit, user, type, reason);
      res.json({ success: true, id: info.lastInsertRowid });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Batch Create Transactions
  app.post('/api/transactions/batch', (req, res) => {
    const transactions = req.body; // Array of transaction objects
    
    const insert = db.prepare(`
      INSERT INTO transactions (date, disp_no, drug_id, drug_name, lot_no, exp_date, pack_size, qty, price_per_unit, user, transaction_type, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const updateDispNo = () => {
       // Generate Disp No (Year + Running)
      const year = new Date().getFullYear() + 543;
      const shortYear = year.toString().slice(-2);
      const countStmt = db.prepare("SELECT COUNT(*) as count FROM transactions WHERE disp_no LIKE ?");
      const count = countStmt.get(`${shortYear}%`) as { count: number };
      return { shortYear, count: count.count };
    };

    const runTransaction = db.transaction((txs) => {
      let { shortYear, count } = updateDispNo();
      
      for (const tx of txs) {
        count++;
        const disp_no = `${shortYear}${count.toString().padStart(3, '0')}`;
        
        let finalQty = parseInt(tx.qty);
        if (tx.type === 'OUT') {
          finalQty = -Math.abs(finalQty);
        }

        insert.run(
          tx.date, 
          disp_no, 
          tx.drug_id, 
          tx.drug_name, 
          tx.lot_no, 
          tx.exp_date, 
          tx.pack_size, 
          finalQty, 
          tx.price_per_unit, 
          tx.user, 
          tx.type, 
          tx.reason
        );
      }
    });

    try {
      runTransaction(transactions);
      res.json({ success: true, count: transactions.length });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // Get Formulary
  app.get('/api/formulary', (req, res) => {
    const stmt = db.prepare('SELECT * FROM formulary');
    res.json(stmt.all());
  });

  // Update Formulary
  app.put('/api/formulary/:id', (req, res) => {
    const { id } = req.params;
    const { min_stock, cabinet, reorder_point, shelf_location, status } = req.body;
    
    const stmt = db.prepare(`
      UPDATE formulary 
      SET min_stock = COALESCE(?, min_stock),
          cabinet = COALESCE(?, cabinet),
          reorder_point = COALESCE(?, reorder_point),
          shelf_location = COALESCE(?, shelf_location),
          status = COALESCE(?, status)
      WHERE drug_id = ?
    `);
    
    const info = stmt.run(min_stock, cabinet, reorder_point, shelf_location, status, id);
    res.json({ changes: info.changes });
  });

  // Audit: Get Random Items
  app.get('/api/audit/random', (req, res) => {
    const stock = getStockSummary();
    
    // Shuffle array
    const shuffled = stock.sort(() => 0.5 - Math.random());
    
    // Pick 5 low stock (if available) and 5 others
    const lowStock = shuffled.filter(i => i.qty < i.min_stock).slice(0, 5);
    const others = shuffled.filter(i => i.qty >= i.min_stock).slice(0, 5);
    
    res.json([...lowStock, ...others]);
  });

  // Audit: Save Result
  app.post('/api/audit', (req, res) => {
    const { items, user } = req.body;
    
    const insert = db.prepare(`
      INSERT INTO audit_trail (action, details, user)
      VALUES (?, ?, ?)
    `);

    const runAudit = db.transaction((auditItems) => {
      for (const item of auditItems) {
        const details = `Audit: ${item.drug_name} (Lot: ${item.lot_no}). System: ${item.qty}, Actual: ${item.actual_qty}, Diff: ${item.actual_qty - item.qty}`;
        insert.run('AUDIT_COUNT', details, user);
        
        // Optionally adjust stock if requested (not implemented here for safety, just logging)
      }
    });

    try {
      runAudit(items);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Settings: Get
  app.get('/api/settings', (req, res) => {
    const stmt = db.prepare('SELECT * FROM settings');
    const rows = stmt.all() as { key: string, value: string }[];
    const settings = rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
    res.json(settings);
  });

  // Settings: Save
  app.post('/api/settings', (req, res) => {
    const settings = req.body;
    const insert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    
    const runSettings = db.transaction((data) => {
      for (const [key, value] of Object.entries(data)) {
        insert.run(key, value);
      }
    });

    try {
      runSettings(settings);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Helper to get stock summary
  function getStockSummary() {
    // Get all transactions
    const txs = db.prepare('SELECT * FROM transactions').all() as any[];
    const formulary = db.prepare('SELECT * FROM formulary').all() as any[];
    
    // Group by Drug + Lot
    const stockMap = new Map();

    txs.forEach(tx => {
      const key = `${tx.drug_id}|${tx.lot_no}`;
      if (!stockMap.has(key)) {
        stockMap.set(key, {
          drug_id: tx.drug_id,
          drug_name: tx.drug_name,
          lot_no: tx.lot_no,
          exp_date: tx.exp_date,
          qty: 0,
          price: tx.price_per_unit,
          pack_size: tx.pack_size
        });
      }
      const item = stockMap.get(key);
      item.qty += tx.qty;
      // Update price to latest IN transaction price if available
      if (tx.transaction_type === 'IN') {
        item.price = tx.price_per_unit;
      }
    });

    // Merge with formulary data
    const result = [];
    for (const item of stockMap.values()) {
      const form = formulary.find(f => f.drug_id === item.drug_id);
      result.push({
        ...item,
        min_stock: form ? form.min_stock : 0,
        cabinet: form ? form.cabinet : '',
        shelf: form ? form.shelf_location : ''
      });
    }
    
    return result;
  }

  // Vite middleware
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
