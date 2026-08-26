import { eq, desc, asc, and, or, like, gte, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { 
  InsertUser, 
  users, 
  categories, 
  bankAccounts, 
  transactions, 
  budgets, 
  categorizationRules,
  creditCards,
  creditCardTransactions,
  monthlyBalances,
  profileHistory,
  importHistory,
  type Category,
  type BankAccount,
  type Transaction,
  type Budget,
  type CategorizationRule,
  type CreditCard,
  type CreditCardTransaction,
  type MonthlyBalance,
  type ProfileHistory,
  type ImportHistory,
} from "../drizzle/schema";
import { createWorker } from 'tesseract.js';
import { PDFDocument } from 'pdf-lib';

// Matches the fallback used in server/_core/oauth.ts when provisioning the owner account.
const OWNER_OPEN_ID = process.env.OWNER_OPEN_ID || "bia-owner";
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let _db: any = null;
let _pool: mysql.Pool | null = null;
let _initAttempted = false;
let _tesseractWorker: any = null;

// Initialize Tesseract worker
async function getTesseractWorker() {
  if (!_tesseractWorker) {
    _tesseractWorker = await createWorker('por'); // Portuguese language
  }
  return _tesseractWorker;
}

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (_db && _pool) return _db; // já conectado

  if (!process.env.DATABASE_URL) return null;

  try {
    if (!_pool) {
      const dbUrl = process.env.DATABASE_URL || "";
      _pool = mysql.createPool({
        uri: dbUrl.replace(/\?ssl=.*$/, ""),
        ssl: { rejectUnauthorized: false },
        waitForConnections: true,
        connectionLimit: 5,
      });
    }

    if (!_db) {
      _db = drizzle(_pool, { mode: 'default', schema: { users, categories, bankAccounts, transactions, budgets, categorizationRules, creditCards, creditCardTransactions, monthlyBalances, profileHistory } });
    }

    // Ensure profileHistory table exists
    if (!_initAttempted) {
      _initAttempted = true;
      try {
        await _pool.execute(`
          CREATE TABLE IF NOT EXISTS \`profileHistory\` (
            \`id\` int AUTO_INCREMENT NOT NULL,
            \`userId\` int NOT NULL,
            \`fieldName\` varchar(100) NOT NULL,
            \`oldValue\` text,
            \`newValue\` text,
            \`changedAt\` timestamp NOT NULL DEFAULT (now()),
            \`createdAt\` timestamp NOT NULL DEFAULT (now()),
            CONSTRAINT \`profileHistory_id\` PRIMARY KEY(\`id\`)
          )
        `);
      } catch (tableError) {
        console.warn("[Database] Could not create profileHistory table:", tableError);
      }
    }
  } catch (error) {
    console.warn("[Database] Failed to connect:", error);
    _db = null;
    _pool = null;
  }

  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === OWNER_OPEN_ID) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// ============= CATEGORIES =============

export async function getCategories(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(categories).where(eq(categories.userId, userId)).orderBy(asc(categories.name));
}

export async function getCategoryById(id: number, userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(categories).where(and(eq(categories.id, id), eq(categories.userId, userId))).limit(1);
  return result[0];
}

export async function createCategory(userId: number, data: { name: string; type: "income" | "expense"; color: string; icon: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(categories).values({ userId, ...data });
  return result;
}

export async function updateCategory(id: number, userId: number, data: Partial<{ name: string; color: string; icon: string }>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.update(categories).set(data).where(and(eq(categories.id, id), eq(categories.userId, userId)));
}

export async function deleteCategory(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.delete(categories).where(and(eq(categories.id, id), eq(categories.userId, userId)));
}

// ============= BANK ACCOUNTS =============

export async function getBankAccounts(userId: number) {
  const db = await getDb();
  if (!db) return [];
  
  const accounts = await db.select().from(bankAccounts).where(eq(bankAccounts.userId, userId)).orderBy(asc(bankAccounts.name));
  
  // Calcular saldo final para cada conta (SALDO INICIAL + ENTRADAS - SAÍDAS do mês atual)
  const currentMonth = new Date().getMonth() + 1;
  const currentYear = new Date().getFullYear();
  
  const accountsWithFinalBalance = await Promise.all(
    accounts.map(async (account: any) => {
      try {
        const txList = await db
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.accountId, account.id),
              eq(transactions.userId, userId)
            )
          );
        
        // Calcular entradas e saídas do mês atual
        let monthlyIncome = 0;
        let monthlyExpense = 0;
        
        txList.forEach((tx: any) => {
          const txDate = new Date(tx.date);
          if (txDate.getMonth() + 1 === currentMonth && txDate.getFullYear() === currentYear) {
            if (tx.type === "income") {
              monthlyIncome += parseFloat(tx.amount || "0");
            } else {
              monthlyExpense += parseFloat(tx.amount || "0");
            }
          }
        });
        
        const initialBalance = parseFloat(account.balance || "0");
        const finalBalance = initialBalance + monthlyIncome - monthlyExpense;
        
        return {
          ...account,
          balance: account.balance,
          finalBalance: finalBalance.toString(),
        };
      } catch (error) {
        console.error(`Error calculating balance for account ${account.id}:`, error);
        return {
          ...account,
          finalBalance: account.balance,
        };
      }
    })
  );
  
  return accountsWithFinalBalance;
}

export async function getBankAccountById(id: number, userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(bankAccounts).where(and(eq(bankAccounts.id, id), eq(bankAccounts.userId, userId))).limit(1);
  return result[0];
}

export async function createBankAccount(userId: number, data: { name: string; bank: string; accountNumber?: string; initialBalance: string; color?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(bankAccounts).values({ 
    userId, 
    ...data,
    balance: data.initialBalance,
    finalBalance: data.initialBalance,
  });
  return result;
}

export async function updateBankAccount(id: number, userId: number, data: Partial<{ name: string; bank: string; accountNumber: string; balance: string; initialBalance: string; finalBalance: string; color: string }>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.update(bankAccounts).set(data).where(and(eq(bankAccounts.id, id), eq(bankAccounts.userId, userId)));
}

export async function deleteBankAccount(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.delete(bankAccounts).where(and(eq(bankAccounts.id, id), eq(bankAccounts.userId, userId)));
}

// ============= TRANSACTIONS =============

export async function getTransactions(userId: number, filters?: { accountId?: number; categoryId?: number; type?: "income" | "expense"; startDate?: Date; endDate?: Date }) {
  const db = await getDb();
  if (!db) return [];

  const conditions: ReturnType<typeof eq>[] = [eq(transactions.userId, userId) as any];
  if (filters?.accountId) conditions.push(eq(transactions.accountId, filters.accountId) as any);
  if (filters?.categoryId) conditions.push(eq(transactions.categoryId, filters.categoryId) as any);
  if (filters?.type) conditions.push(eq(transactions.type, filters.type) as any);
  if (filters?.startDate) conditions.push(gte(transactions.date, filters.startDate) as any);
  if (filters?.endDate) conditions.push(lte(transactions.date, filters.endDate) as any);

  return db.select().from(transactions).where(and(...conditions)).orderBy(desc(transactions.date));
}

export async function getTransactionById(id: number, userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(transactions).where(and(eq(transactions.id, id), eq(transactions.userId, userId))).limit(1);
  return result[0];
}

export async function createTransaction(userId: number, data: { categoryId: number; accountId: number; type: "income" | "expense"; description: string; amount: string; date: Date; notes?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.insert(transactions).values({ userId, ...data });
}

export async function updateTransaction(id: number, userId: number, data: Partial<{ categoryId: number; description: string; amount: string; date: Date; notes: string; reconciled: boolean; reconciledAt: Date }>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.update(transactions).set(data).where(and(eq(transactions.id, id), eq(transactions.userId, userId)));
}

export async function deleteTransaction(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.delete(transactions).where(and(eq(transactions.id, id), eq(transactions.userId, userId)));
}

// ============= BUDGETS =============

export async function getBudgets(userId: number, month?: number, year?: number) {
  const db = await getDb();
  if (!db) return [];

  const conditions: any[] = [eq(budgets.userId, userId)];
  if (month !== undefined) conditions.push(eq(budgets.month, month));
  if (year !== undefined) conditions.push(eq(budgets.year, year));

  return db.select().from(budgets).where(and(...conditions)).orderBy(asc(budgets.categoryId));
}

export async function getBudgetById(id: number, userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(budgets).where(and(eq(budgets.id, id), eq(budgets.userId, userId))).limit(1);
  return result[0];
}

export async function createBudget(userId: number, data: { categoryId: number; month: number; year: number; limit: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.insert(budgets).values({ userId, ...data });
}

export async function updateBudget(id: number, userId: number, data: Partial<{ limit: string }>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.update(budgets).set(data).where(and(eq(budgets.id, id), eq(budgets.userId, userId)));
}

export async function deleteBudget(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.delete(budgets).where(and(eq(budgets.id, id), eq(budgets.userId, userId)));
}

// ============= CATEGORIZATION RULES =============

export async function getCategorizationRules(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(categorizationRules).where(eq(categorizationRules.userId, userId)).orderBy(desc(categorizationRules.priority));
}

export async function getCategorizationRuleById(id: number, userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(categorizationRules).where(and(eq(categorizationRules.id, id), eq(categorizationRules.userId, userId))).limit(1);
  return result[0];
}

export async function createCategorizationRule(userId: number, data: { categoryId: number; keywords: string[]; matchType: "contains" | "exact" | "startsWith" | "endsWith"; caseSensitive: boolean; priority: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.insert(categorizationRules).values({ userId, categoryId: data.categoryId, keywords: JSON.stringify(data.keywords), matchType: data.matchType, caseSensitive: data.caseSensitive, priority: data.priority });
}

export async function updateCategorizationRule(id: number, userId: number, data: Partial<{ categoryId: number; keywords: string[]; matchType: "contains" | "exact" | "startsWith" | "endsWith"; caseSensitive: boolean; priority: number; enabled: boolean }>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const updateData: any = { ...data };
  if (data.keywords) {
    updateData.keywords = JSON.stringify(data.keywords);
  }
  return db.update(categorizationRules).set(updateData).where(and(eq(categorizationRules.id, id), eq(categorizationRules.userId, userId)));
}

export async function deleteCategorizationRule(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.delete(categorizationRules).where(and(eq(categorizationRules.id, id), eq(categorizationRules.userId, userId)));
}

/**
 * Apply categorization rules to all transactions in a bank account
 * Returns the number of transactions that were categorized
 */
export async function applyCategorizationRulesToAccount(userId: number, accountId: number, startDate?: string, endDate?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  // Get all enabled rules for the user, ordered by priority (highest first)
  const rules = await db
    .select()
    .from(categorizationRules)
    .where(and(
      eq(categorizationRules.userId, userId),
      eq(categorizationRules.enabled, true)
    ))
    .orderBy(desc(categorizationRules.priority));
  
  if (rules.length === 0) {
    return 0; // No rules to apply
  }
  
  // Build where conditions for transactions
  const whereConditions: any[] = [
    eq(transactions.userId, userId),
    eq(transactions.accountId, accountId)
  ];
  
  // Add date filters if provided
  if (startDate) {
    whereConditions.push(gte(transactions.date, new Date(startDate)));
  }
  if (endDate) {
    whereConditions.push(lte(transactions.date, new Date(endDate)));
  }
  
  // Get transactions for the account (with optional date filtering)
  const accountTransactions = await db
    .select()
    .from(transactions)
    .where(and(...whereConditions));
  
  let categorizedCount = 0;
  
  // For each transaction, try to match against rules
  for (const transaction of accountTransactions) {
    // Skip if already has a category (don't override existing categorization)
    // Uncomment the line below if you want to skip already categorized transactions
    // if (transaction.categoryId) continue;
    
    // Try to match against rules (in priority order)
    for (const rule of rules) {
      if (matchesRule(transaction.description, rule)) {
        // Update the transaction with the matched category
        await db
          .update(transactions)
          .set({ categoryId: rule.categoryId })
          .where(eq(transactions.id, transaction.id));
        
        categorizedCount++;
        break; // Stop after first match (highest priority)
      }
    }
  }
  
  return categorizedCount;
}

/**
 * Check if a transaction description matches a categorization rule
 */
function matchesRule(description: string, rule: CategorizationRule): boolean {
  const keywords = parseKeywords(rule.keywords);
  const testDescription = rule.caseSensitive ? description : description.toLowerCase();
  
  for (const keyword of keywords) {
    const testKeyword = rule.caseSensitive ? keyword : keyword.toLowerCase();
    
    switch (rule.matchType) {
      case "contains":
        if (testDescription.includes(testKeyword)) return true;
        break;
      case "exact":
        if (testDescription === testKeyword) return true;
        break;
      case "startsWith":
        if (testDescription.startsWith(testKeyword)) return true;
        break;
      case "endsWith":
        if (testDescription.endsWith(testKeyword)) return true;
        break;
    }
  }
  
  return false;
}

/**
 * Parse keywords from JSON string or array
 */
function parseKeywords(keywordsData: string | string[]): string[] {
  if (Array.isArray(keywordsData)) {
    return keywordsData;
  }
  
  try {
    const parsed = JSON.parse(keywordsData);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // If JSON parsing fails, treat as single keyword
  }
  
  // Fallback: treat as single keyword string
  return [keywordsData];
}

// ============= CREDIT CARDS =============

export async function getCreditCards(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(creditCards).where(eq(creditCards.userId, userId)).orderBy(asc(creditCards.name));
}

export async function getCreditCardById(id: number, userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(creditCards).where(and(eq(creditCards.id, id), eq(creditCards.userId, userId))).limit(1);
  return result[0];
}

export async function createCreditCard(userId: number, data: { name: string; brand: string; limit: string; dueDay: number; closingDay: number; color: string; lastFourDigits?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.insert(creditCards).values({ userId, ...data });
}

export async function updateCreditCard(id: number, userId: number, data: Partial<{ name: string; brand: string; limit: string; dueDay: number; closingDay: number; color: string; lastFourDigits: string }>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.update(creditCards).set(data).where(and(eq(creditCards.id, id), eq(creditCards.userId, userId)));
}

export async function deleteCreditCard(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.delete(creditCards).where(and(eq(creditCards.id, id), eq(creditCards.userId, userId)));
}

// ============= CREDIT CARD TRANSACTIONS =============

export async function getCreditCardTransactions(userId: number, cardId?: number) {
  const db = await getDb();
  if (!db) return [];

  const conditions: any[] = [eq(creditCardTransactions.userId, userId)];
  if (cardId) conditions.push(eq(creditCardTransactions.cardId, cardId));

  return db.select().from(creditCardTransactions).where(and(...conditions)).orderBy(desc(creditCardTransactions.date));
}

export async function getCreditCardTransactionById(id: number, userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(creditCardTransactions).where(and(eq(creditCardTransactions.id, id), eq(creditCardTransactions.userId, userId))).limit(1);
  return result[0];
}

export async function createCreditCardTransaction(userId: number, data: { cardId: number; categoryId?: number; description: string; amount: string; date: Date; dueDate?: Date; installments?: number; currentInstallment?: number; notes?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.insert(creditCardTransactions).values({ userId, ...data });
}

export async function updateCreditCardTransaction(id: number, userId: number, data: Partial<{ categoryId: number; description: string; amount: string; date: Date; dueDate: Date; installments: number; currentInstallment: number; paid: boolean; paidAt: Date; notes: string }>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.update(creditCardTransactions).set(data).where(and(eq(creditCardTransactions.id, id), eq(creditCardTransactions.userId, userId)));
}

export async function deleteCreditCardTransaction(id: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.delete(creditCardTransactions).where(and(eq(creditCardTransactions.id, id), eq(creditCardTransactions.userId, userId)));
}

// ============= DASHBOARD STATS =============

export async function getDashboardStats(userId: number, month: number, year: number) {
  const db = await getDb();
  if (!db) return { totalIncome: "0", totalExpense: "0", totalBalance: "0" };
  
  // Get all transactions for the user (not just current month)
  const transactionStats = await db.select({
    type: transactions.type,
    total: sql<string>`SUM(${transactions.amount})`,
  }).from(transactions).where(
    eq(transactions.userId, userId)
  ).groupBy(transactions.type);
  
  let totalIncome = "0";
  let totalExpense = "0";
  
  for (const stat of transactionStats) {
    if (stat.type === "income") totalIncome = stat.total || "0";
    if (stat.type === "expense") totalExpense = stat.total || "0";
  }
  
  const accounts = await db.select({ balance: sql<string>`SUM(${bankAccounts.balance})` }).from(bankAccounts).where(eq(bankAccounts.userId, userId));
  const totalBalance = accounts[0]?.balance || "0";
  
  return { totalIncome, totalExpense, totalBalance };
}

export async function getCreditCardTransactionsByMonth(userId: number, cardId: number, month: number, year: number) {
  const db = await getDb();
  if (!db) return [];
  
  // Filter by dueDate (when the charge is due) to show all transactions in the invoice for that month
  // Use YEAR() and MONTH() functions for timezone-safe date comparison
  const result = await db.select()
    .from(creditCardTransactions)
    .where(
      and(
        eq(creditCardTransactions.userId, userId),
        eq(creditCardTransactions.cardId, cardId),
        sql`YEAR(${creditCardTransactions.dueDate}) = ${year} AND MONTH(${creditCardTransactions.dueDate}) = ${month}`
      )
    )
    .orderBy(desc(creditCardTransactions.dueDate));
  
  return result;
}

export async function getCreditCardTransactionsByDate(userId: number, startDate: Date, endDate: Date) {
  const db = await getDb();
  if (!db) return [];
  
  // Filter by date (when the transaction was made) for Dashboard summary
  // This is used to show transactions made in a specific month, not by due date
  const result = await db.select()
    .from(creditCardTransactions)
    .where(
      and(
        eq(creditCardTransactions.userId, userId),
        gte(creditCardTransactions.date, startDate),
        lte(creditCardTransactions.date, endDate)
      )
    )
    .orderBy(desc(creditCardTransactions.date));
  
  return result;
}

export async function getCreditCardUtilization(userId: number, cardId: number, month: number, year: number) {
  const db = await getDb();
  if (!db) return null;
  
  const card = await getCreditCardById(cardId, userId);
  if (!card) return null;
  
  const transactions = await getCreditCardTransactionsByMonth(userId, cardId, month, year);
  
  const totalUsed = transactions.reduce((sum: any, t: any) => {
    const amount = parseFloat(t.amount.toString());
    return sum + (amount > 0 ? amount : 0);
  }, 0);
  
  const limit = parseFloat(card.limit.toString());
  const available = limit - totalUsed;
  
  return {
    limit,
    used: totalUsed,
    available: Math.max(0, available),
    percentage: (totalUsed / limit) * 100,
  };
}


export async function updateUserProfile(userId: number, data: { name?: string; email?: string; profilePhoto?: string }) {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  try {
    // Validate that at least one field is provided
    if (!data.name && !data.email && !data.profilePhoto) {
      throw new Error("At least one field (name, email, or profilePhoto) must be provided");
    }

    // Get current user data to compare
    const [currentUser] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    
    if (currentUser) {
      // Record changes for each field
      if (data.name && data.name !== currentUser.name) {
        await recordProfileChange(userId, "name", currentUser.name || null, data.name);
      }
      if (data.email && data.email !== currentUser.email) {
        await recordProfileChange(userId, "email", currentUser.email || null, data.email);
      }
      if (data.profilePhoto && data.profilePhoto !== currentUser.profilePhoto) {
        await recordProfileChange(userId, "profilePhoto", currentUser.profilePhoto || null, data.profilePhoto);
      }
    }

    const result = await db.update(users)
      .set({
        ...(data.name && { name: data.name }),
        ...(data.email && { email: data.email }),
        ...(data.profilePhoto && { profilePhoto: data.profilePhoto }),
      })
      .where(eq(users.id, userId));

    return result;
  } catch (error) {
    console.error("[Database] Error updating user profile:", error);
    throw error;
  }
}


// Monthly Balances functions
export async function getMonthlyBalance(userId: number, accountId: number, month: number, year: number): Promise<MonthlyBalance | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const result = await db.select()
      .from(monthlyBalances)
      .where(
        and(
          eq(monthlyBalances.userId, userId),
          eq(monthlyBalances.accountId, accountId),
          eq(monthlyBalances.month, month),
          eq(monthlyBalances.year, year)
        )
      )
      .limit(1);

    return result[0] || null;
  } catch (error) {
    console.error("[Database] Error getting monthly balance:", error);
    return null;
  }
}

export async function upsertMonthlyBalance(userId: number, accountId: number, month: number, year: number, initialBalance: string): Promise<MonthlyBalance | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const balance = parseFloat(initialBalance);
    if (isNaN(balance)) {
      console.error(`[Database] Invalid balance value: ${initialBalance}`);
      return null;
    }
    
    const existing = await getMonthlyBalance(userId, accountId, month, year);
    
    if (existing) {
      // Update existing
      await db.update(monthlyBalances)
        .set({ initialBalance: balance.toString() })
        .where(eq(monthlyBalances.id, existing.id));
      
      return getMonthlyBalance(userId, accountId, month, year);
    } else {
      // Insert new
      await db.insert(monthlyBalances).values({
        userId,
        accountId,
        month,
        year,
        initialBalance: balance.toString(),
      });

      return getMonthlyBalance(userId, accountId, month, year);
    }
  } catch (error) {
    console.error("[Database] Error upserting monthly balance:", error);
    return null;
  }
}

export async function getInitialBalanceForMonth(userId: number, accountId: number, month: number, year: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  try {
    // Se há saldo definido manualmente para este mês, usa esse valor
    const thisMonthBalance = await getMonthlyBalance(userId, accountId, month, year);
    if (thisMonthBalance) {
      const v = parseFloat(String(thisMonthBalance.initialBalance));
      return isNaN(v) ? 0 : v;
    }

    // Auto-calcular: buscar o saldo customizado mais recente antes deste mês
    const allCustomBalances = await db.select()
      .from(monthlyBalances)
      .where(and(
        eq(monthlyBalances.userId, userId),
        eq(monthlyBalances.accountId, accountId)
      ))
      .orderBy(desc(monthlyBalances.year), desc(monthlyBalances.month));

    const targetDate = new Date(year, month - 1, 1);
    const previousCustomBalance = allCustomBalances.find((b: any) => {
      return new Date(b.year, b.month - 1, 1) < targetDate;
    });

    let startDate: Date;
    let baseBalance: number;

    if (previousCustomBalance) {
      // Parte do mês em que foi definido o saldo customizado
      startDate = new Date(Date.UTC(previousCustomBalance.year, previousCustomBalance.month - 1, 1));
      const parsedBase = parseFloat(String(previousCustomBalance.initialBalance));
      baseBalance = isNaN(parsedBase) ? 0 : parsedBase;
    } else {
      // Sem nenhum saldo customizado anterior: começa do zero
      startDate = new Date(0);
      baseBalance = 0;
    }

    // Fim = último momento UTC do mês anterior ao solicitado
    let prevMonth = month - 1;
    let prevYear = year;
    if (prevMonth === 0) {
      prevMonth = 12;
      prevYear -= 1;
    }
    const endDate = new Date(Date.UTC(prevYear, prevMonth, 0, 23, 59, 59));

    // Somar todas as transações do intervalo para calcular saldo acumulado
    const rangeTransactions = await getTransactions(userId, {
      accountId,
      startDate,
      endDate,
    });

    const totalIncome = rangeTransactions
      .filter((t: any) => t.type === 'income')
      .reduce((sum: number, t: any) => sum + parseFloat(t.amount.toString()), 0);
    const totalExpenses = rangeTransactions
      .filter((t: any) => t.type === 'expense')
      .reduce((sum: number, t: any) => sum + Math.abs(parseFloat(t.amount.toString())), 0);

    const result = baseBalance + totalIncome - totalExpenses;
    return isNaN(result) ? 0 : result;
  } catch (error) {
    console.error("[Database] Error getting initial balance for month:", error);
    return 0;
  }
}

export async function deleteMonthlyBalance(userId: number, accountId: number, month: number, year: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  try {
    const monthlyBalance = await getMonthlyBalance(userId, accountId, month, year);
    if (!monthlyBalance) return false;

    await db.delete(monthlyBalances)
      .where(eq(monthlyBalances.id, monthlyBalance.id));

    return true;
  } catch (error) {
    console.error("[Database] Error deleting monthly balance:", error);
    return false;
  }
}


// ============= PROFILE HISTORY =============

export async function recordProfileChange(userId: number, fieldName: string, oldValue: string | null, newValue: string | null) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  // Only record if values actually changed
  if (oldValue === newValue) return;
  
  return db.insert(profileHistory).values({
    userId,
    fieldName,
    oldValue: oldValue ? JSON.stringify(oldValue) : null,
    newValue: newValue ? JSON.stringify(newValue) : null,
  });
}

export async function getProfileHistory(userId: number, limit: number = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(profileHistory).where(eq(profileHistory.userId, userId)).orderBy(desc(profileHistory.changedAt)).limit(limit);
}

export async function importCreditCardTransactionsFromPDF(userId: number, data: { cardId: number; pdfBase64: string; fileName: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database not initialized");

  try {
    // Verify card belongs to user
    const card = await db.select().from(creditCards).where(
      and(eq(creditCards.id, data.cardId), eq(creditCards.userId, userId))
    ).limit(1);
    
    if (!card.length) {
      throw new Error("Cartão não encontrado");
    }

    // For now, return a success message
    // In a real implementation, you would:
    // 1. Convert PDF to text using a library like pdf-parse
    // 2. Parse the text to extract transactions
    // 3. Create transactions in the database
    // 4. Return the number of transactions imported

    return {
      success: true,
      message: "Fatura importada com sucesso",
      transactionsImported: 0,
      fileName: data.fileName,
    };
  } catch (error) {
    throw new Error(`Erro ao importar fatura: ${error instanceof Error ? error.message : "Erro desconhecido"}`);
  }
}


// Import OFX transactions for credit cards
export async function importCreditCardTransactionsFromOFX(userId: number, data: { cardId: number; ofxContent: string; fileName: string }) {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    
    const card = await db.select().from(creditCards).where(
      and(eq(creditCards.id, data.cardId), eq(creditCards.userId, userId))
    ).limit(1);
    
    if (!card.length) {
      throw new Error("Cartão não encontrado");
    }

    // For now, return a success message
    // In a real implementation, you would:
    // 1. Parse the OFX content to extract transactions
    // 2. Create transactions in the database
    // 3. Return the number of transactions imported

    return {
      success: true,
      message: "Arquivo OFX importado com sucesso",
      transactionsImported: 0,
      fileName: data.fileName,
    };
  } catch (error) {
    throw new Error(`Erro ao importar OFX: ${error instanceof Error ? error.message : "Erro desconhecido"}`);
  }
}

// Import OFX transactions for bank accounts
export async function importTransactionsFromOFX(userId: number, data: { accountId: number; ofxContent: string; fileName: string }) {
  try {
    const db = await getDb();
    
    const account = await db.select().from(bankAccounts).where(
      and(eq(bankAccounts.id, data.accountId), eq(bankAccounts.userId, userId))
    ).limit(1);
    
    if (!account.length) {
      throw new Error("Conta bancária não encontrada");
    }

    // For now, return a success message
    // In a real implementation, you would:
    // 1. Parse the OFX content to extract transactions
    // 2. Create transactions in the database
    // 3. Return the number of transactions imported

    return {
      success: true,
      message: "Arquivo OFX importado com sucesso",
      transactionsImported: 0,
      fileName: data.fileName,
    };
  } catch (error) {
    throw new Error(`Erro ao importar OFX: ${error instanceof Error ? error.message : "Erro desconhecido"}`);
  }
}


// ============= IMPORTAÇÃO INTELIGENTE (detecção automática de cartão/conta) =============

export async function getActiveCategorizationRules(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(categorizationRules)
    .where(and(eq(categorizationRules.userId, userId), eq(categorizationRules.enabled, true)))
    .orderBy(desc(categorizationRules.priority));
}

export interface DetectedEntity {
  entityType: "creditCard" | "bankAccount";
  entityId: number;
  label: string;
  confidence: "high" | "low";
}

/**
 * Descobre a qual cartão/conta cadastrado um documento (fatura/extrato) lido
 * pela IA pertence, a partir dos metadados extraídos do próprio PDF
 * (banco, bandeira, últimos 4 dígitos, número da conta). Usado pelo fluxo
 * de importação sem pré-seleção manual (Importar.tsx) — a pessoa só sobe o
 * arquivo, sem escolher o cartão/conta antes.
 *
 * Retorna null quando não há candidato suficientemente confiável — nesse
 * caso quem chamou deve pedir pra pessoa confirmar manualmente, em vez de
 * arriscar lançar a fatura inteira no cartão errado.
 */
export async function detectEntityFromDocument(
  userId: number,
  doc: {
    documentType: "creditCardInvoice" | "bankStatement" | "unknown";
    issuerBank: string | null;
    cardBrand: string | null;
    cardLastFourDigits: string | null;
    accountNumber: string | null;
  }
): Promise<DetectedEntity | null> {
  const normalize = (s: string | null | undefined) => (s ?? "").toLowerCase().trim();

  if (doc.documentType === "creditCardInvoice") {
    const cards = await getCreditCards(userId);
    if (cards.length === 0) return null;

    // 1) Match forte: últimos 4 dígitos batem exatamente.
    if (doc.cardLastFourDigits) {
      const last4 = doc.cardLastFourDigits.replace(/\D/g, "");
      const exact = cards.filter((c: CreditCard) => (c.lastFourDigits || "").replace(/\D/g, "") === last4);
      if (exact.length === 1) {
        return { entityType: "creditCard", entityId: exact[0].id, label: exact[0].name, confidence: "high" };
      }
    }

    // 2) Match fraco: só um cartão cadastrado com essa bandeira.
    if (doc.cardBrand) {
      const brand = normalize(doc.cardBrand);
      const byBrand = cards.filter((c: CreditCard) => normalize(c.brand).includes(brand) || brand.includes(normalize(c.brand)));
      if (byBrand.length === 1) {
        return { entityType: "creditCard", entityId: byBrand[0].id, label: byBrand[0].name, confidence: "low" };
      }
    }

    // 3) Só existe um cartão cadastrado no total — provavelmente é esse.
    if (cards.length === 1) {
      return { entityType: "creditCard", entityId: cards[0].id, label: cards[0].name, confidence: "low" };
    }

    return null;
  }

  if (doc.documentType === "bankStatement") {
    const accounts = await getBankAccounts(userId);
    if (accounts.length === 0) return null;

    // 1) Match forte: número da conta bate. Tolerante a zero à esquerda
    // (ex: "038502" salvo como "38502" na hora de cadastrar a conta — bem
    // comum digitar sem o zero) e a agência colada no número salvo (ex:
    // "7040038502" quando a fatura só traz "038502" da conta em si) — nesse
    // segundo caso só aceita dentro do MESMO banco, pra não confundir conta
    // de bancos diferentes que por acaso terminem nos mesmos dígitos.
    if (doc.accountNumber) {
      const num = doc.accountNumber.replace(/\D/g, "").replace(/^0+/, "");
      const bank = normalize(doc.issuerBank);
      const exact = accounts.filter((a: BankAccount) => {
        if (num.length === 0) return false;
        const stored = (a.accountNumber || "").replace(/\D/g, "").replace(/^0+/, "");
        if (stored.length === 0) return false;
        if (stored === num) return true;
        // Agência+conta colados: um é sufixo do outro, mesmo banco, e o
        // menor tem dígitos suficientes pra não ser coincidência boba.
        const sameBank = doc.issuerBank ? normalize(a.bank).includes(bank) || bank.includes(normalize(a.bank)) : false;
        if (!sameBank) return false;
        const shorter = stored.length <= num.length ? stored : num;
        const longer = stored.length <= num.length ? num : stored;
        return shorter.length >= 4 && longer.endsWith(shorter);
      });
      if (exact.length === 1) {
        return { entityType: "bankAccount", entityId: exact[0].id, label: exact[0].name, confidence: "high" };
      }
    }

    // 2) Match fraco: só uma conta cadastrada nesse banco.
    if (doc.issuerBank) {
      const bank = normalize(doc.issuerBank);
      const byBank = accounts.filter((a: BankAccount) => normalize(a.bank).includes(bank) || bank.includes(normalize(a.bank)));
      if (byBank.length === 1) {
        return { entityType: "bankAccount", entityId: byBank[0].id, label: byBank[0].name, confidence: "low" };
      }
    }

    if (accounts.length === 1) {
      return { entityType: "bankAccount", entityId: accounts[0].id, label: accounts[0].name, confidence: "low" };
    }

    return null;
  }

  return null;
}

// Generic file import function for both credit cards and bank accounts
export async function importFile(userId: number, data: {
  entityType: "creditCard" | "bankAccount"; 
  entityId: number; 
  fileContent: string; 
  fileName: string; 
  fileType: string;
  transactions?: Array<{date: Date; description: string; amount: string; type: "income" | "expense"; categoryId?: number; installments?: number; currentInstallment?: number}>;
  dueDate?: Date;
}) {
  try {
    console.log('[importFile] Starting import for', data.entityType, 'ID:', data.entityId, 'transactions provided:', data.transactions?.length || 0);
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    
    if (data.entityType === "creditCard") {
      const card = await db.select().from(creditCards).where(
        and(eq(creditCards.id, data.entityId), eq(creditCards.userId, userId))
      ).limit(1);
      
      if (!card.length) {
        throw new Error("Cartão não encontrado");
      }

      // Garantir AUTO_INCREMENT no campo id
      try {
        await getDb(); // garante que _pool está inicializado
        if (_pool) {
          await _pool.execute('ALTER TABLE `creditCardTransactions` MODIFY `id` INT NOT NULL AUTO_INCREMENT');
        }
      } catch (e) { /* ignora se já existir */ }

      // Garantir que todas as datas são objetos Date (tRPC serializa como string)
      let extractedTransactions: Array<{date: Date; description: string; amount: string; type: "income" | "expense"; categoryId?: number; installments?: number; currentInstallment?: number}> =
        (data.transactions || []).map(tx => ({
          ...tx,
          date: new Date(tx.date),
        }));

      console.log('[importFile] Transações do frontend:', extractedTransactions.length);

      // Só tenta parsear PDF se não vieram transações prontas do frontend
      if (extractedTransactions.length === 0 && (data.fileType === "application/pdf" || data.fileName.endsWith(".pdf"))) {
        console.log('[importFile] Processing PDF, content length:', data.fileContent.length);
        
        // Decode base64 if needed
        let pdfContent = data.fileContent;
        if (!data.fileContent.startsWith('%PDF')) {
          try {
            const buffer = Buffer.from(data.fileContent, 'base64');
            pdfContent = buffer.toString('latin1');
            console.log('[importFile] Decoded base64 PDF, length:', pdfContent.length);
          } catch (e) {
            console.log('[importFile] Failed to decode base64:', e);
            pdfContent = data.fileContent;
          }
        }
        
        // Find the "Lançamentos" section
        const lancamentosIndex = pdfContent.indexOf('Lançamentos');
        if (lancamentosIndex !== -1) {
          const lancamentosSection = pdfContent.substring(lancamentosIndex);
          const lines = lancamentosSection.split('\n');
          console.log('[importFile] Found Lançamentos section with', lines.length, 'lines');
          
          // Parse transactions from the Lançamentos section
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Look for lines starting with date (DD/MM)
            const dateMatch = line.match(/^(\d{1,2})\/(\d{1,2})\s+(.+)$/);
            if (dateMatch) {
              const day = dateMatch[1];
              const month = dateMatch[2];
              const description = dateMatch[3].trim();
              
              // Look for amount in the same line or next lines
              let amount = '';
              
              // Check if amount is in the same line
              const amountInLine = line.match(/R\$\s*([\d.,]+)/);
              if (amountInLine) {
                amount = amountInLine[1];
              } else {
                // Look in next few lines for the amount
                for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
                  const nextLine = lines[j].trim();
                  const nextAmount = nextLine.match(/R\$\s*([\d.,]+)/);
                  if (nextAmount) {
                    amount = nextAmount[1];
                    break;
                  }
                }
              }
              
              if (amount) {
                try {
                  // Create a date - use current year if not specified
                  const currentYear = new Date().getFullYear();
                  const dateStr = `${month}/${day}/${currentYear}`;
                  const date = new Date(dateStr);
                  
                  // Convert amount format: "1.234,56" -> "1234.56"
                  const cleanAmount = amount.replace(/\./g, '').replace(',', '.');
                  
                  if (!isNaN(date.getTime()) && !isNaN(parseFloat(cleanAmount))) {
                    extractedTransactions.push({
                      date,
                      description: description.substring(0, 100),
                      amount: cleanAmount,
                      type: "expense"
                    });
                    console.log('[importFile] Extracted transaction:', {date: dateStr, description, amount: cleanAmount});
                  }
                } catch (e) {
                  console.log('[importFile] Error parsing transaction:', e);
                }
              }
            }
          }
        }
      }
      
      // Regras como fallback quando categoryId não vem do frontend
      let rules = [];
      try {
        rules = await db.select().from(categorizationRules).where(eq(categorizationRules.userId, userId)).orderBy(desc(categorizationRules.priority));
      } catch (e) {
        console.log('[importFile] Could not load categorization rules:', e);
      }
      
      // Create transactions in database
      console.log('[importFile] Found', extractedTransactions.length, 'transactions to create');
      let transactionsCreated = 0;
      const errors: string[] = [];
      
      // Use confirmed dueDate from import, or calculate if not provided
      const cardDetails = card[0];
      const closingDay = cardDetails.closingDay;
      const dueDay = cardDetails.dueDay;
      
      for (const tx of extractedTransactions) {
        try {
          let categoryId: number | null = tx.categoryId ?? null;
          if (!categoryId && rules.length > 0) {
            const { applyCategorizationRules } = await import('./categorizationEngine');
            categoryId = applyCategorizationRules(tx.description, rules) || null;
          }

          // Validar datas
          const txDate = new Date(tx.date);
          if (isNaN(txDate.getTime())) {
            errors.push(`${tx.description}: data inválida: ${tx.date}`);
            continue;
          }

          // Uma fatura só lista o que já aconteceu (mais a tabela de
          // parcelas futuras, que o prompt já instrui ignorar). Se ainda
          // assim aparecer uma transação com data no futuro, é sinal de
          // erro de extração (ano inferido errado, ou uma linha da tabela
          // de projeção que escapou) — não importa, avisa em vez de deixar
          // passar um dado que não pode estar certo.
          if (txDate.getTime() > Date.now()) {
            errors.push(`${tx.description}: data no futuro (${tx.date}), ignorada — provável erro de extração`);
            continue;
          }

          // Calcular dueDate
          let dueDate: Date;
          if (data.dueDate) {
            dueDate = new Date(data.dueDate);
          } else {
            const txDay = txDate.getDate();
            const txMonth = txDate.getMonth();
            const txYear = txDate.getFullYear();
            if (txDay >= closingDay) {
              dueDate = new Date(txYear, txMonth + 1, dueDay);
            } else {
              dueDate = new Date(txYear, txMonth, dueDay);
            }
          }

          if (isNaN(dueDate.getTime())) {
            errors.push(`${tx.description}: dueDate inválida`);
            continue;
          }

          // Garantir amount como decimal válido, preservando o sinal (o "-"
          // é o que a regex anterior removia, fazendo todo estorno/crédito
          // virar despesa positiva).
          const cleanAmount = String(tx.amount).replace(/[^0-9.-]/g, '');
          const numericAmount = parseFloat(cleanAmount);
          if (isNaN(numericAmount)) {
            errors.push(`${tx.description}: amount inválido: ${tx.amount}`);
            continue;
          }
          // creditCardTransactions não tem coluna "type" — quem diferencia
          // estorno/crédito (valor negativo) de compra/despesa (valor
          // positivo) nas telas que consomem essa tabela é o sinal do
          // amount (ver client/src/lib/transactionClassifier.ts). O type
          // vindo da classificação (IA ou ajuste manual do usuário) é a
          // fonte da verdade aqui, em vez de confiar que o valor já chegou
          // com o sinal certo do frontend.
          const signedAmount = tx.type === "income" ? -Math.abs(numericAmount) : Math.abs(numericAmount);
          const finalAmount = signedAmount.toFixed(2);

          // Parcelamento: extraído pela IA (ou informado pelo usuário) a
          // partir da notação impressa na fatura (ex: "03/10"). 1/1 quando
          // não é parcelado.
          const installmentsTotal =
            tx.installments && tx.installments > 0 ? Math.trunc(tx.installments) : 1;
          const installmentsCurrent =
            tx.currentInstallment && tx.currentInstallment > 0 ? Math.trunc(tx.currentInstallment) : 1;

          // Usar SQL raw para contornar bug do Drizzle com MySQL
          if (!_pool) throw new Error('Database pool not available');

          const toMySQLDate = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

          if (categoryId !== null && categoryId !== undefined) {
            await _pool.execute(
              'INSERT INTO `creditCardTransactions` (`cardId`, `userId`, `categoryId`, `date`, `dueDate`, `description`, `amount`, `installments`, `currentInstallment`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [data.entityId, userId, categoryId, toMySQLDate(txDate), toMySQLDate(dueDate), String(tx.description).substring(0, 255), parseFloat(finalAmount), installmentsTotal, installmentsCurrent]
            );
          } else {
            await _pool.execute(
              'INSERT INTO `creditCardTransactions` (`cardId`, `userId`, `date`, `dueDate`, `description`, `amount`, `installments`, `currentInstallment`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [data.entityId, userId, toMySQLDate(txDate), toMySQLDate(dueDate), String(tx.description).substring(0, 255), parseFloat(finalAmount), installmentsTotal, installmentsCurrent]
            );
          }
          transactionsCreated++;
        } catch (e) {
          const msg = `${tx.description}: ${(e as any)?.message || String(e)}`;
          console.error('[importFile] Erro:', msg);
          errors.push(msg);
        }
      }

      console.log('[importFile] Import completed, created', transactionsCreated, 'transactions');
      
      // Record import history
      try {
        await recordImportHistory(userId, {
          entityType: 'creditCard',
          entityId: data.entityId,
          fileName: data.fileName,
          fileType: data.fileType,
          bankDetected: data.transactions?.[0]?.description ? 'Detected' : undefined, // Placeholder
          transactionsImported: transactionsCreated,
          duplicatesFound: 0, // TODO: Track duplicates
          duplicatesSkipped: 0,
          status: transactionsCreated > 0 ? 'success' : 'partial',
        });
      } catch (e) {
        console.log('[importFile] Failed to record import history:', e);
      }
      
      return {
        success: true,
        message: `Arquivo importado com sucesso. ${transactionsCreated} transações criadas.`,
        transactionsImported: transactionsCreated,
        fileName: data.fileName,
        debug: `Recebidas: ${extractedTransactions.length}, Criadas: ${transactionsCreated}, Erros: ${errors.length}`,
        errors: errors.slice(0, 5), // primeiros 5 erros
      };
    } else if (data.entityType === "bankAccount") {
      const account = await db.select().from(bankAccounts).where(
        and(eq(bankAccounts.id, data.entityId), eq(bankAccounts.userId, userId))
      ).limit(1);
      
      if (!account.length) {
        throw new Error("Conta bancária não encontrada");
      }

      // Garantir AUTO_INCREMENT no campo id
      try {
        if (_pool) {
          await _pool.execute('ALTER TABLE `transactions` MODIFY `id` INT NOT NULL AUTO_INCREMENT');
        }
      } catch (e) { /* ignora se já existir */ }

      // Se vieram transações prontas do frontend, usar diretamente
      let extractedTransactions: Array<{date: Date; description: string; amount: string; type: "income" | "expense"; categoryId?: number}> = [];

      if (data.transactions && data.transactions.length > 0) {
        extractedTransactions = data.transactions.map(tx => ({
          ...tx,
          date: new Date(tx.date),
        }));
        console.log('[importFile] Usando', extractedTransactions.length, 'transações do frontend para conta bancária');
      } else if (data.fileType === "application/pdf" || data.fileName.endsWith(".pdf")) {
        // Decode base64 if needed
        let pdfContent = data.fileContent;
        if (!data.fileContent.startsWith('%PDF')) {
          try {
            const buffer = Buffer.from(data.fileContent, 'base64');
            pdfContent = buffer.toString('latin1');
            console.log('[importFile] Decoded base64 PDF for bank account, length:', pdfContent.length);
          } catch (e) {
            console.log('[importFile] Failed to decode base64:', e);
            pdfContent = data.fileContent;
          }
        }
        
        // Try BRB parser first
        try {
          const { detectBRBFormat, parseBRBStatement } = await import('./parsers/brb-parser');
          if (detectBRBFormat(pdfContent)) {
            console.log('[importFile] Detected BRB format, using specialized parser');
            extractedTransactions = parseBRBStatement(pdfContent);
          }
        } catch (e) {
          console.log('[importFile] BRB parser not available, using fallback');
        }
        
        // Fallback: generic parsing if BRB parser didn't work
        if (extractedTransactions.length === 0) {
          const lines = pdfContent.split('\n');
          const datePattern = /(\d{1,2}\/(\d{1,2}|\d{4}))/g;
          const amountPattern = /R\$\s*([\d.,]+)/g;
          
          lines.forEach(line => {
            const dateMatch = line.match(datePattern);
            const amountMatch = line.match(amountPattern);
            
            if (dateMatch && amountMatch) {
              try {
                const dateStr = dateMatch[0];
                const amountStr = amountMatch[0].replace('R$ ', '').replace(/\./g, '').replace(',', '.');
                const date = new Date(dateStr);
                
                if (!isNaN(date.getTime())) {
                  extractedTransactions.push({
                    date,
                    description: line.substring(0, 50),
                    amount: amountStr,
                    type: "expense"
                  });
                }
              } catch (e) {
                // Skip invalid entries
              }
            }
          });
        }
      }
      
      // Regras como fallback quando categoryId não vem do frontend
      let rules = [];
      try {
        rules = await db.select().from(categorizationRules).where(eq(categorizationRules.userId, userId)).orderBy(desc(categorizationRules.priority));
      } catch (e) {
        console.log('[importFile] Could not load categorization rules:', e);
      }

      // Buscar ou criar categoria padrão "Sem categoria" para transações sem categoria
      let defaultCategoryId: number;
      try {
        const existing = await db.select().from(categories)
          .where(and(eq(categories.userId, userId), eq(categories.name, "Sem categoria")))
          .limit(1);
        if (existing.length > 0) {
          defaultCategoryId = existing[0].id;
        } else {
          const result = await db.insert(categories).values({
            userId,
            name: "Sem categoria",
            type: "expense",
            color: "#9ca3af",
            icon: "tag",
          });
          defaultCategoryId = (result as any).insertId;
        }
      } catch (e) {
        console.log('[importFile] Could not get/create default category:', e);
        defaultCategoryId = 1; // fallback extremo
      }
      
      // Create transactions in database
      let transactionsCreated = 0;
      const bankErrors: string[] = [];
      for (const tx of extractedTransactions) {
        try {
          if (!db) throw new Error("Database not available");
          
          // Usar categoryId do frontend, regras como fallback, ou categoria padrão
          let categoryId: number = (tx as any).categoryId ?? 0;
          if (!categoryId && rules.length > 0) {
            const { applyCategorizationRules } = await import('./categorizationEngine');
            categoryId = applyCategorizationRules(tx.description, rules) || defaultCategoryId;
          }
          if (!categoryId) categoryId = defaultCategoryId;

          // Garantir amount válido
          const cleanAmt = String(tx.amount).replace(/[^0-9.]/g, '');
          const numAmt = parseFloat(cleanAmt);
          if (isNaN(numAmt)) { bankErrors.push(`${tx.description}: amount inválido`); continue; }
          const finalAmt = Math.abs(numAmt).toFixed(2);

          const txDate = new Date(tx.date);
          if (isNaN(txDate.getTime())) { bankErrors.push(`${tx.description}: data inválida`); continue; }

          // Um extrato só lista o que já aconteceu (mais a seção de
          // "lançamentos futuros"/agendados, que o prompt já instrui
          // ignorar). Se ainda assim aparecer uma transação com data no
          // futuro, é sinal de erro de extração — não importa, avisa em vez
          // de deixar passar um dado que não pode estar certo.
          if (txDate.getTime() > Date.now()) {
            bankErrors.push(`${tx.description}: data no futuro (${tx.date}), ignorada — provável erro de extração`);
            continue;
          }

          const toMySQLDate = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

          if (!_pool) throw new Error('Database pool not available');
          await _pool.execute(
            'INSERT INTO `transactions` (`userId`, `categoryId`, `accountId`, `type`, `description`, `amount`, `date`, `reconciled`) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
            [userId, categoryId, data.entityId, tx.type || 'expense', String(tx.description).substring(0, 255), parseFloat(finalAmt), toMySQLDate(txDate)]
          );
          transactionsCreated++;
        } catch (e) {
          bankErrors.push(`${tx.description}: ${(e as any)?.message || String(e)}`);
        }
      }

      return {
        success: true,
        message: `Arquivo importado com sucesso. ${transactionsCreated} transações criadas.`,
        transactionsImported: transactionsCreated,
        fileName: data.fileName,
        debug: `Recebidas: ${extractedTransactions.length}, Criadas: ${transactionsCreated}, Erros: ${bankErrors.length}`,
        errors: bankErrors.slice(0, 5),
      };
    } else {
      throw new Error("Tipo de entidade inválido");
    }
  } catch (error) {
    throw new Error(`Erro ao importar arquivo: ${error instanceof Error ? error.message : "Erro desconhecido"}`);
  }
}


// ============= DUPLICATE DETECTION HELPERS =============

const normalizeText = (text: string): string => {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "");
};

const normalizeAmount = (amount: string | number): number => {
  if (typeof amount === "number") {
    return parseFloat(amount.toFixed(2));
  }
  const cleaned = amount.replace(/[^0-9.,]/g, "").replace(",", ".");
  return parseFloat(cleaned);
};

const calculateStringSimilarity = (str1: string, str2: string): number => {
  const s1 = normalizeText(str1);
  const s2 = normalizeText(str2);

  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  if (s1.includes(s2) || s2.includes(s1)) {
    return 0.9;
  }

  // Levenshtein distance
  const matrix: number[][] = [];

  for (let i = 0; i <= s2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= s1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= s2.length; i++) {
    for (let j = 1; j <= s1.length; j++) {
      if (s2.charAt(i - 1) === s1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  const distance = matrix[s2.length][s1.length];
  const maxLength = Math.max(s1.length, s2.length);
  return 1 - distance / maxLength;
};

// ============= DUPLICATE DETECTION =============

export async function checkDuplicatesForImport(
  userId: number,
  data: {
    entityType: "creditCard" | "bankAccount";
    entityId: number;
    transactions: Array<{ date: Date; description: string; amount: string }>;
    dateToleranceDays?: number;
    descriptionSimilarityThreshold?: number;
    amountTolerancePercent?: number;
  }
) {
  const db = await getDb();
  if (!db) {
    return {
      duplicates: [],
      new: data.transactions.map((tx) => ({
        ...tx,
        isDuplicate: false,
      })),
    };
  }

  const dateToleranceDays = data.dateToleranceDays ?? 0;
  const descriptionThreshold = data.descriptionSimilarityThreshold ?? 0.85;
  const amountTolerancePercent = data.amountTolerancePercent ?? 0;

  try {
    let existingTransactions: any[] = [];

    if (data.entityType === "creditCard") {
      existingTransactions = await db
        .select()
        .from(creditCardTransactions)
        .where(
          and(
            eq(creditCardTransactions.userId, userId),
            eq(creditCardTransactions.cardId, data.entityId)
          )
        );
    } else {
      existingTransactions = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.accountId, data.entityId)
          )
        );
    }

    // Check each new transaction for duplicates
    const duplicates = [];
    const newTransactions = [];

    for (const newTx of data.transactions) {
      let isDuplicate = false;
      let matchedTransaction = null;

      const newAmount = normalizeAmount(newTx.amount);
      const newDate = new Date(newTx.date);

      for (const existingTx of existingTransactions) {
        const existingAmount = normalizeAmount(existingTx.amount);
        const existingDate = new Date(existingTx.date);

        // Check date match (with tolerance)
        const daysDiff = Math.abs(
          (newDate.getTime() - existingDate.getTime()) / (1000 * 60 * 60 * 24)
        );

        if (daysDiff > dateToleranceDays) {
          continue;
        }

        // Check amount match (with tolerance)
        const amountDiff = Math.abs(newAmount - existingAmount);
        const amountDiffPercent = (amountDiff / existingAmount) * 100;

        if (amountDiffPercent > amountTolerancePercent) {
          continue;
        }

        // Check description similarity
        const descriptionSimilarity = calculateStringSimilarity(
          newTx.description,
          existingTx.description
        );

        if (descriptionSimilarity >= descriptionThreshold) {
          isDuplicate = true;
          matchedTransaction = {
            id: existingTx.id,
            date: existingTx.date,
            description: existingTx.description,
            amount: existingTx.amount,
          };
          break;
        }
      }

      if (isDuplicate) {
        duplicates.push({
          ...newTx,
          isDuplicate: true,
          matchedTransaction,
        });
      } else {
        newTransactions.push({
          ...newTx,
          isDuplicate: false,
        });
      }
    }

    return {
      duplicates,
      new: newTransactions,
      summary: {
        total: data.transactions.length,
        duplicateCount: duplicates.length,
        newCount: newTransactions.length,
      },
    };
  } catch (error) {
    console.error("[checkDuplicatesForImport] Error:", error);
    return {
      duplicates: [],
      new: data.transactions.map((tx) => ({
        ...tx,
        isDuplicate: false,
      })),
      error: error instanceof Error ? error.message : "Erro desconhecido",
    };
  }
}


// ============= IMPORT HISTORY =============

export async function recordImportHistory(userId: number, data: {
  entityType: "creditCard" | "bankAccount";
  entityId: number;
  fileName: string;
  fileType: string;
  bankDetected?: string;
  transactionsImported: number;
  duplicatesFound: number;
  duplicatesSkipped?: number;
  status: "success" | "partial" | "failed";
  errorMessage?: string;
}) {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const result = await db.insert(importHistory).values({
      userId,
      entityType: data.entityType,
      entityId: data.entityId,
      fileName: data.fileName,
      fileType: data.fileType,
      bankDetected: data.bankDetected,
      transactionsImported: data.transactionsImported,
      duplicatesFound: data.duplicatesFound,
      duplicatesSkipped: data.duplicatesSkipped || 0,
      status: data.status,
      errorMessage: data.errorMessage,
    });

    return result;
  } catch (error) {
    console.error("[recordImportHistory] Error:", error);
    throw error;
  }
}

export async function getImportHistory(userId: number, entityType?: "creditCard" | "bankAccount", entityId?: number) {
  try {
    const db = await getDb();
    if (!db) return [];

    let query = db.select()
      .from(importHistory)
      .where(eq(importHistory.userId, userId));

    if (entityType) {
      query = query.where(eq(importHistory.entityType, entityType));
    }

    if (entityId) {
      query = query.where(eq(importHistory.entityId, entityId));
    }

    const result = await query.orderBy(desc(importHistory.importedAt));
    return result;
  } catch (error) {
    console.error("[getImportHistory] Error:", error);
    return [];
  }
}

export async function getImportHistoryById(userId: number, historyId: number) {
  try {
    const db = await getDb();
    if (!db) return null;

    const result = await db.select()
      .from(importHistory)
      .where(
        and(
          eq(importHistory.userId, userId),
          eq(importHistory.id, historyId)
        )
      )
      .limit(1);

    return result.length > 0 ? result[0] : null;
  } catch (error) {
    console.error("[getImportHistoryById] Error:", error);
    return null;
  }
}

export async function getImportStatistics(userId: number, entityType?: "creditCard" | "bankAccount") {
  try {
    const db = await getDb();
    if (!db) return null;

    let query = db.select({
      totalImports: sql<number>`COUNT(*)`,
      totalTransactionsImported: sql<number>`SUM(${importHistory.transactionsImported})`,
      totalDuplicatesFound: sql<number>`SUM(${importHistory.duplicatesFound})`,
      successfulImports: sql<number>`SUM(CASE WHEN ${importHistory.status} = 'success' THEN 1 ELSE 0 END)`,
      failedImports: sql<number>`SUM(CASE WHEN ${importHistory.status} = 'failed' THEN 1 ELSE 0 END)`,
    })
      .from(importHistory)
      .where(eq(importHistory.userId, userId));

    if (entityType) {
      query = query.where(eq(importHistory.entityType, entityType));
    }

    const result = await query;
    return result.length > 0 ? result[0] : null;
  } catch (error) {
    console.error("[getImportStatistics] Error:", error);
    return null;
  }
}
