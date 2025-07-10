const { Builder, By, Key, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const express = require("express");
require('dotenv').config()

// Open SQLite database
const initializeDB = async () => {
  const db = await open({
    filename: "swipe_data.db",
    driver: sqlite3.Database,
  });

  try {
    // First, check if the table exists
    const tableExists = await db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='status'`);

    if (tableExists) {
      // Check if we need to add new columns
      const columnInfo = await db.all(`PRAGMA table_info(status)`);
      const columns = columnInfo.map(col => col.name);

      // Add missing columns if needed
      if (!columns.includes('estimatedCompletionTime')) {
        await db.exec(`ALTER TABLE status ADD COLUMN estimatedCompletionTime TEXT DEFAULT ''`);
        console.log("Added estimatedCompletionTime column");
      }

      if (!columns.includes('bufferTime')) {
        await db.exec(`ALTER TABLE status ADD COLUMN bufferTime TEXT DEFAULT ''`);
        console.log("Added bufferTime column");
      }

      if (!columns.includes('targetEndTime')) {
        await db.exec(`ALTER TABLE status ADD COLUMN targetEndTime TEXT DEFAULT '18:30'`);
        console.log("Added targetEndTime column");
      }
    } else {
      // Create table if it doesn't exist
      await db.exec(`
          CREATE TABLE IF NOT EXISTS status (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              totalHours REAL,
              currentStatus INTEGER,
              estimatedCompletionTime TEXT,
              bufferTime TEXT,
              targetEndTime TEXT
          )
      `);

      // Insert initial row
      await db.run(`
          INSERT OR IGNORE INTO status (id, totalHours, currentStatus, estimatedCompletionTime, bufferTime, targetEndTime)
          VALUES (1, 0, 0, '', '', '18:30')
      `);
    }
  } catch (error) {
    console.error("Database initialization error:", error);
  }

  return db;
};

// Function to update all status information
const updateStatus = async (db, totalHours, currentStatus, estimatedCompletionTime, bufferTime, targetEndTime) => {
  await db.run(
    `UPDATE status SET totalHours = ?, currentStatus = ?, estimatedCompletionTime = ?, bufferTime = ?, targetEndTime = ? WHERE id = 1`,
    totalHours, currentStatus, estimatedCompletionTime, bufferTime, targetEndTime
  );
  console.log(`Database updated: Total Hours = ${totalHours}, Current Status = ${currentStatus ? "IN" : "OUT"}, Estimated Completion = ${estimatedCompletionTime}, Buffer Time = ${bufferTime}`);
};

// Function to log in and fetch cookies
const loginAndGetCookies = async () => {
  const options = new chrome.Options();
  options.addArguments("--headless");
  options.addArguments("--disable-gpu");
  options.addArguments("--no-sandbox");
  options.addArguments("--disable-dev-shm-usage");

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
  let cookies = [];

  try {
    await driver.get("https://smartshiphub.greythr.com/uas/portal/auth/login");
    await driver.wait(until.elementLocated(By.id("username")), 10000);
    await driver.findElement(By.id("username")).sendKeys(process.env.PASSWORD);
    await driver.wait(until.elementLocated(By.id(process.env.USERNAME)), 10000);
    await driver.findElement(By.id("password")).sendKeys(process.env.USERNAME, Key.RETURN);
    await driver.wait(until.urlContains("/home"), 10000);
    console.log("Login successful!");
    cookies = await driver.manage().getCookies();
  } catch (err) {
    console.error("Error during login:", err.message);
  } finally {
    await driver.quit();
  }

  return cookies;
};

// Function to fetch API data
const fetchSwipeData = async (cookies) => {
  try {
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const response = await axios.get("https://smartshiphub.greythr.com/v3/api/attendance/swipes", {
      headers: {
        Cookie: cookieHeader,
        "User-Agent": "Mozilla/5.0",
      },
    });
    return response.data;
  } catch (err) {
    console.error("Error fetching swipe data:", err.message);
    return [];
  }
};

// Convert time string (HH:MM) to minutes
const timeToMinutes = (timeStr) => {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
};

// Convert minutes to time string in 12h format
const minutesToTime12h = (minutes) => {
  const hours24 = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const period = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 || 12; // Convert 0 to 12 for 12 AM
  return `${hours12}:${String(mins).padStart(2, '0')} ${period}`;
};

// Format time string from 24h to 12h
const formatTo12Hour = (timeStr) => {
  if (!timeStr || timeStr === "N/A" || timeStr === "Completed" || timeStr === "Not checked in") {
    return timeStr;
  }

  try {
    const [hoursStr, minutesStr] = timeStr.split(':');
    const hours = parseInt(hoursStr, 10);
    const minutes = parseInt(minutesStr, 10);

    if (isNaN(hours) || isNaN(minutes)) {
      return timeStr;
    }

    const period = hours >= 12 ? "PM" : "AM";
    const hours12 = hours % 12 || 12;
    return `${hours12}:${String(minutes).padStart(2, '0')} ${period}`;
  } catch (err) {
    console.error("Error formatting time to 12h:", err);
    return timeStr;
  }
};

// Calculate time difference in minutes
const getTimeDifference = (time1, time2) => {
  return timeToMinutes(time1) - timeToMinutes(time2);
};

// Format minutes to HH:MM
const formatMinutesToHoursMinutes = (totalMinutes) => {
  // Handle negative times
  const isNegative = totalMinutes < 0;
  const absMinutes = Math.abs(totalMinutes);

  const hours = Math.floor(absMinutes / 60);
  const minutes = Math.floor(absMinutes % 60);

  return `${isNegative ? '-' : ''}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

// Process swipe data to calculate total hours, status, and time estimates
const processSwipeData = (swipeData) => {
  // Sort swipe data by punch time
  swipeData.sort((a, b) => new Date(a.punchTime) - new Date(b.punchTime));

  let totalSeconds = 0;
  let lastInTime = null;
  let currentStatus = 0;

  swipeData.forEach((swipe) => {
    const punchTime = new Date(swipe.punchTime);
    if (swipe.inOutIndicator === 1) {
      lastInTime = punchTime;
      currentStatus = 1;
    } else if (swipe.inOutIndicator === 0 && lastInTime) {
      totalSeconds += (punchTime - lastInTime) / 1000;
      lastInTime = null;
      currentStatus = 0;
    }
  });

  const now = new Date();
  let estimatedCompletionTime = null;

  // If currently IN, add time from last punch to now
  if (currentStatus === 1 && lastInTime) {
    let lastPunchTime = new Date(swipeData[swipeData.length - 1].punchTime + 'z');
    console.log("Current status is IN. Adding time from last punch to now");
    totalSeconds += (now - lastPunchTime) / 1000;
    console.log(`Currently IN. Adding time from last punch to now: ${Math.floor((now - lastPunchTime) / 1000)} seconds`);
  }

  // Calculate total time
  const totalHours = parseFloat((totalSeconds / 3600).toFixed(2));
  const totalMinutes = Math.floor(totalSeconds / 60);
  const formattedTime = `${String(Math.floor(totalHours)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;

  // Target work duration in seconds (8 hours)
  const targetWorkDuration = 8 * 3600;

  // Default target end time is 18:30 (6:30 PM)
  const targetEndTime = "18:30";

  // Calculate estimated completion time if currently IN and not yet reached 8 hours
  let bufferTimeMinutes = 0;

  if (currentStatus === 1) {
    if (totalSeconds < targetWorkDuration) {
      // Calculate remaining seconds
      const remainingSeconds = targetWorkDuration - totalSeconds;

      // Calculate estimated completion time
      const estimatedCompletionDate = new Date(now.getTime() + remainingSeconds * 1000);
      const hours = estimatedCompletionDate.getHours();
      const minutes = estimatedCompletionDate.getMinutes();
      const time24h = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
      estimatedCompletionTime = formatTo12Hour(time24h);

      // Calculate buffer time (time between estimated completion and target end time)
      const targetMinutes = timeToMinutes(targetEndTime);
      const estimatedMinutes = hours * 60 + minutes;

      bufferTimeMinutes = targetMinutes - estimatedMinutes;
    } else {
      // Already completed 8 hours
      estimatedCompletionTime = "Completed";

      // Buffer time is negative (overtime)
      const overtimeSeconds = totalSeconds - targetWorkDuration;
      bufferTimeMinutes = -Math.ceil(overtimeSeconds / 60);
    }
  } else {
    // If OUT, show estimates based on current progress
    if (totalSeconds < targetWorkDuration) {
      estimatedCompletionTime = "Not checked in";

      // Calculate remaining work time
      const remainingMinutes = Math.ceil((targetWorkDuration - totalSeconds) / 60);

      // Calculate buffer based on remaining work time vs time until target end
      const nowHours = now.getHours();
      const nowMinutes = now.getMinutes();
      const currentTimeMinutes = nowHours * 60 + nowMinutes;
      const targetMinutes = timeToMinutes(targetEndTime);

      // Available time until target end minus required work time
      bufferTimeMinutes = (targetMinutes - currentTimeMinutes) - remainingMinutes;
    } else {
      estimatedCompletionTime = "Completed";
      bufferTimeMinutes = 0; // No buffer needed, work is done
    }
  }

  // Format buffer time
  const bufferTime = formatMinutesToHoursMinutes(bufferTimeMinutes);
  const targetEnd12h = formatTo12Hour(targetEndTime);

  // Log results
  console.log(`Total hours: ${formattedTime}, Current Status: ${currentStatus ? "IN" : "OUT"}`);
  console.log(`Estimated Completion Time: ${estimatedCompletionTime}, Buffer Time: ${bufferTime}`);

  return {
    totalHours: formattedTime,
    currentStatus,
    estimatedCompletionTime,
    bufferTime,
    targetEndTime: targetEnd12h,
    rawHours: totalHours
  };
};

// Main periodic updater
setInterval(async () => {
  try {
    const db = await initializeDB();
    const cookies = await loginAndGetCookies();
    const swipeData = await fetchSwipeData(cookies);
    const result = processSwipeData(swipeData);
    await updateStatus(
      db,
      result.totalHours,
      result.currentStatus,
      result.estimatedCompletionTime,
      result.bufferTime,
      result.targetEndTime
    );
  } catch (err) {
    console.error("Error:", err.message);
  }
}, 50000); // Run every ~50 seconds

// Express Server
const app = express();

// Endpoint to get swipe data
app.get("/getSwipeData", async (req, res) => {
  try {
    const db = await initializeDB();

    // Use a more flexible approach in case some columns are missing
    const row = await db.get("SELECT * FROM status WHERE id = 1");

    if (!row) {
      throw new Error("No data found in status table");
    }

    res.json({
      totalHours: row.totalHours || 0,
      currentStatus: row.currentStatus ? "IN" : "OUT",
      estimatedCompletionTime: row.estimatedCompletionTime || "N/A",
      bufferTime: row.bufferTime || "N/A",
      targetEndTime: row.targetEndTime || "18:30"
    });
  } catch (err) {
    console.error("Error fetching swipe data from DB:", err.message);
    // Return default values instead of failing
    res.json({
      totalHours: "00:00",
      currentStatus: "OUT",
      estimatedCompletionTime: "N/A",
      bufferTime: "N/A",
      targetEndTime: "18:30"
    });
  }
});

// Endpoint to update target end time
app.get("/updateTargetTime/:time", async (req, res) => {
  try {
    const targetTime = req.params.time;
    // Validate time format (HH:MM)
    if (!/^\d{2}:\d{2}$/.test(targetTime)) {
      return res.status(400).json({ error: "Invalid time format. Use HH:MM" });
    }

    const db = await initializeDB();
    await db.run("UPDATE status SET targetEndTime = ? WHERE id = 1", targetTime);

    res.json({ success: true, message: `Target end time updated to ${targetTime}` });
  } catch (err) {
    console.error("Error updating target time:", err.message);
    res.status(500).json({ error: "Failed to update target time" });
  }
});

// Start server
const PORT = 6847;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});