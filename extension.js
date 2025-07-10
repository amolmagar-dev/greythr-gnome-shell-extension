"use strict";

const GETTEXT_DOMAIN = "dock-swipe-tracker";

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const St = imports.gi.St;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const GLib = imports.gi.GLib;
const Soup = imports.gi.Soup;
const GObject = imports.gi.GObject;
const Clutter = imports.gi.Clutter;
const ByteArray = imports.byteArray;
const Gio = imports.gi.Gio;

let extension;

const DockSwipeTracker = GObject.registerClass(
  class DockSwipeTracker extends PanelMenu.Button {
    _init() {
      super._init(0.0, `${Me.metadata.name}`);

      // Load CSS
      this._loadStylesheet();

      // Panel button layout
      this.panelContainer = new St.BoxLayout({
        style_class: "swipe-panel",
        reactive: true,
        track_hover: true,
      });

      // Status icon that changes based on IN/OUT status
      this.statusIcon = new St.Icon({
        style_class: "status-icon",
        icon_name: "system-run-symbolic",
        icon_size: 18,
      });

      // Time label showing hours worked
      this.timeLabel = new St.Label({
        style_class: "time-label",
        text: "-- H",
      });

      // Add components to panel
      this.panelContainer.add_child(this.statusIcon);
      this.panelContainer.add_child(this.timeLabel);
      this.add_child(this.panelContainer);

      // Menu content
      this.menu.box.add_style_class_name("modern-menu");

      // Create main container
      this.mainContainer = new St.BoxLayout({
        style_class: "main-container",
        vertical: true,
      });

      // Header with total hours and status
      this.headerContainer = new St.BoxLayout({
        style_class: "header-container",
        vertical: false,
      });

      // Large time display
      this.largeTimeLabel = new St.Label({
        style_class: "large-time-label",
        text: "0.0h",
      });

      // Status indicator
      this.statusBadge = new St.Label({
        style_class: "status-badge",
        text: "OUT",
      });

      this.headerContainer.add_child(this.largeTimeLabel);
      this.headerContainer.add_child(this.statusBadge);

      // Stats section - using simple vertical layout instead of grid
      this.statsContainer = new St.BoxLayout({
        style_class: "stats-container",
        vertical: true,
      });

      // First row of stats
      this.statsRow1 = new St.BoxLayout({
        style_class: "stats-row",
        vertical: false,
      });

      // Second row of stats  
      this.statsRow2 = new St.BoxLayout({
        style_class: "stats-row",
        vertical: false,
      });

      // Create stat cards
      this.statCards = {};
      const stats = [
        { key: 'completion', label: 'Est. End', value: '--:--' },
        { key: 'progress', label: 'Progress', value: '0%' },
        { key: 'inTime', label: 'In Time', value: '--:--' },
        { key: 'lastOut', label: 'Last Out', value: '--:--' }
      ];

      stats.forEach((stat, index) => {
        const card = this._createStatCard(stat.label, stat.value);
        this.statCards[stat.key] = card;
        
        // Add to row 1 or row 2
        if (index < 2) {
          this.statsRow1.add_child(card);
        } else {
          this.statsRow2.add_child(card);
        }
      });

      // Add rows to stats container
      this.statsContainer.add_child(this.statsRow1);
      this.statsContainer.add_child(this.statsRow2);

      // Weekly progress section
      this.weeklyContainer = new St.BoxLayout({
        style_class: "weekly-container",
        vertical: false,
      });

      // Create day indicators (Monday to Saturday only)
      this.dayIndicators = {};
      const daysOfWeek = ['M', 'T', 'W', 'T', 'F', 'S'];
      const dayKeys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

      dayKeys.forEach((dayKey, index) => {
        const dayIndicator = this._createDayIndicator(daysOfWeek[index], dayKey);
        this.dayIndicators[dayKey] = dayIndicator;
        this.weeklyContainer.add_child(dayIndicator);
      });

      // Add all sections to main container
      this.mainContainer.add_child(this.headerContainer);
      this.mainContainer.add_child(this.statsContainer);
      this.mainContainer.add_child(this.weeklyContainer);

      // Add main container to menu
      let mainMenuItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        style_class: "main-menu-item",
      });
      mainMenuItem.add_child(this.mainContainer);
      this.menu.addMenuItem(mainMenuItem);

      // Initialize state
      this._status = "OUT";
      this._totalTime = 0;
      this._estimatedCompletionTime = "N/A";
      this._bufferTime = "N/A";
      this._targetEndTime = "18:30";
      this._lastUpdate = new Date();
      this._inTime = "--:--";
      this._lastOut = "--:--";

      // Weekly data storage
      this._weeklyData = {};
      this._weeklyStats = {
        totalHours: 0,
        completedDays: 0,
        avgDaily: 0,
        targetProgress: 0
      };

      // Start polling
      this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
        this._fetchSwipeData();
        return GLib.SOURCE_CONTINUE;
      });

      // Initial data fetch
      this._fetchSwipeData();
    }

    _createStatCard(label, value) {
      const card = new St.BoxLayout({
        style_class: "stat-card",
        vertical: true,
      });

      const valueLabel = new St.Label({
        style_class: "stat-value",
        text: value,
      });

      const labelText = new St.Label({
        style_class: "stat-label",
        text: label,
      });

      card.add_child(valueLabel);
      card.add_child(labelText);

      // Store references directly on the card widget
      card._valueLabel = valueLabel;
      card._labelText = labelText;

      return card;
    }

    _createDayIndicator(dayLetter, dayKey) {
      const circle = new St.Button({
        style_class: "day-circle",
        width: 36,
        height: 36,
        reactive: false,
      });

      const label = new St.Label({
        style_class: "day-letter",
        text: dayLetter,
      });

      circle.set_child(label);

      // Store references directly on the circle
      circle._label = label;
      circle._dayKey = dayKey;

      return circle;
    }

    _loadStylesheet() {
      let stylesheetPath = GLib.build_filenamev([Me.path, "stylesheet.css"]);
      let stylesheetFile = Gio.File.new_for_path(stylesheetPath);

      const css = `
.swipe-panel {
    padding: 5px 12px;
    background-color: rgba(40,40,40,0.85);
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.1);
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    margin: 2px 6px;
}

.swipe-panel:hover {
    background-color: rgba(60,60,60,0.95);
}

.status-icon {
    margin-right: 8px;
}

.time-label {
    font-weight: bold;
    font-size: 13px;
    color: #fff;
}

.modern-menu {
    padding: 0;
    border-radius: 16px;
    background-color: rgba(25, 25, 25, 0.98);
    border: 1px solid rgba(255,255,255,0.1);
    box-shadow: 0 12px 32px rgba(0,0,0,0.3);
    margin: 5px;
}

.main-container {
    padding: 20px;
    spacing: 12px;
}

.header-container {
    spacing: 12px;
}

.large-time-label {
    font-size: 28px;
    font-weight: bold;
    color: #00bcd4;
}

.status-badge {
    font-size: 10px;
    font-weight: bold;
    color: #00ff00;
    background-color: rgba(0, 255, 0, 0.15);
    border: 1px solid rgba(0, 255, 0, 0.4);
    border-radius: 6px;
    padding: 4px 8px;
    margin-top: 6px;
}

.status-badge.out {
    color: #ff6b6b;
    background-color: rgba(255, 107, 107, 0.15);
    border-color: rgba(255, 107, 107, 0.4);
}

.stats-container {
    spacing: 6px;
}

.stats-row {
    spacing: 6px;
}

.stat-card {
    background-color: rgba(45, 45, 45, 0.9);
    border-radius: 8px;
    padding: 8px 10px;
    spacing: 2px;
    width: 125px;
}

.stat-value {
    font-size: 13px;
    font-weight: bold;
    color: #ffffff;
}

.stat-label {
    font-size: 8px;
    color: #888888;
    text-transform: uppercase;
}

.weekly-container {
    spacing: 4px;
}

.day-circle {
    border-radius: 18px;
    background-color: rgba(80, 80, 80, 0.7);
    border: 2px solid rgba(255,255,255,0.15);
    width: 36px;
    height: 36px;
    padding: 0;
    margin: 0;
}

.day-circle.completed {
    background-color: rgba(0, 188, 212, 0.2);
    border-color: #00bcd4;
}

.day-circle.today {
    background-color: #00bcd4;
    border-color: #00bcd4;
}

.day-circle.partial {
    background-color: rgba(255, 193, 7, 0.2);
    border-color: #ffc107;
}

.day-letter {
    font-size: 11px;
    font-weight: bold;
    color: #ffffff;
    text-align: center;
}

.main-menu-item {
    padding: 0;
}`;

      try {
        let [, etag] = stylesheetFile.replace_contents(css, null, false, Gio.FileCreateFlags.NONE, null);

        let theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        theme.load_stylesheet(stylesheetFile);

        this._stylesheet = stylesheetFile;
      } catch (e) {
        logError(e, "Failed to load stylesheet");
      }
    }

    _fetchWeeklyData() {
      log('[DockSwipeTracker] Fetching weekly data...');

      let httpSession = new Soup.Session();
      let message = new Soup.Message({
        method: 'GET',
        uri: new Soup.URI('http://localhost:6847/getWeeklyData')
      });

      httpSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
        try {
          const bytes = session.send_and_read_finish(result);
          const data = ByteArray.toString(bytes.get_data());

          log(`[DockSwipeTracker] Weekly Response: ${data}`);
          
          if (message.status_code === Soup.Status.OK) {
            const jsonResponse = JSON.parse(data);
            this._weeklyData = jsonResponse;
            this._calculateWeeklyStats();
            this._updateWeeklyUI();
            log(`[DockSwipeTracker] Weekly data updated successfully`);
          } else {
            log(`[DockSwipeTracker] Failed to fetch weekly data. Status Code: ${message.status_code}`);
          }
        } catch (e) {
          logError(e, 'DockSwipeTracker - Error fetching weekly data');
        }
      });
    }

    _calculateWeeklyStats() {
      const workdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
      const allDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      let totalHours = 0;
      let completedDays = 0;

      allDays.forEach(day => {
        const dayData = this._weeklyData[day];
        if (dayData && dayData.totalInTime) {
          const hours = parseFloat(dayData.totalInTime) || 0;
          totalHours += hours;
          
          if (this._isWorkday(day) && hours >= 8) {
            completedDays++;
          }
        }
      });

      const targetHours = workdays.length * 8;
      const targetProgress = targetHours > 0 ? Math.round((totalHours / targetHours) * 100) : 0;

      this._weeklyStats = {
        totalHours: totalHours.toFixed(1),
        completedDays: completedDays,
        targetProgress: targetProgress
      };
    }

    _formatTime(timeString) {
      if (!timeString || timeString === "N/A") return "--:--";
      return timeString;
    }

    _formatHours(hours) {
      if (hours === 0) return "0.0h";
      return `${parseFloat(hours).toFixed(1)}h`;
    }

    _isWorkday(dayKey) {
      return ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].includes(dayKey);
    }

    _getCurrentDay() {
      const today = new Date().getDay();
      const dayMap = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      return dayMap[today];
    }

    _updateWeeklyUI() {
      const currentDay = this._getCurrentDay();

      // Update day indicators
      Object.keys(this.dayIndicators).forEach(dayKey => {
        const indicator = this.dayIndicators[dayKey];
        const dayData = this._weeklyData[dayKey];
        const hours = dayData ? parseFloat(dayData.totalInTime) || 0 : 0;
        const isCompleted = hours >= 8 && this._isWorkday(dayKey);
        const isToday = dayKey === currentDay;
        const hasPartialHours = hours > 0 && hours < 8;

        // Remove all classes first
        indicator.remove_style_class_name("completed");
        indicator.remove_style_class_name("today");
        indicator.remove_style_class_name("partial");

        // Apply appropriate styling
        if (isToday) {
          indicator.add_style_class_name("today");
        } else if (isCompleted) {
          indicator.add_style_class_name("completed");
        } else if (hasPartialHours) {
          indicator.add_style_class_name("partial");
        }
      });
    }

    _updateUI() {
      log(`[DockSwipeTracker] Updating UI -> Status: ${this._status}, TotalTime: ${this._totalTime}`);

      const statusColor = this._status === "IN" ? "#9ece6a" : "#f7768e";
      const statusIcon = this._status === "IN" ? "user-available-symbolic" : "user-offline-symbolic";

      // Update panel indicator
      this.statusIcon.set_icon_name(statusIcon);
      this.statusIcon.style = `color: ${statusColor}`;
      this.timeLabel.text = `${this._totalTime.toString()}H`;

      // Update large time display
      this.largeTimeLabel.text = this._formatHours(parseFloat(this._totalTime));

      // Update status badge
      this.statusBadge.text = this._status;
      if (this._status === "OUT") {
        this.statusBadge.add_style_class_name("out");
      } else {
        this.statusBadge.remove_style_class_name("out");
      }

      // Update stat cards
      this.statCards.completion._valueLabel.text = this._formatTime(this._estimatedCompletionTime);
      this.statCards.progress._valueLabel.text = `${this._weeklyStats.targetProgress || 0}%`;
      this.statCards.inTime._valueLabel.text = this._formatTime(this._inTime);
      this.statCards.lastOut._valueLabel.text = this._formatTime(this._lastOut);

      // Update weekly UI
      this._updateWeeklyUI();
    }

    _fetchSwipeData() {
      log('[DockSwipeTracker] Fetching swipe data...');
  
      let httpSession = new Soup.Session();
      let message = new Soup.Message({
          method: 'GET',
          uri: new Soup.URI('http://localhost:6847/getSwipeData')
      });
  
      httpSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
          try {
              const bytes = session.send_and_read_finish(result);
              const data = ByteArray.toString(bytes.get_data());
  
              log(`[DockSwipeTracker] Raw Response: ${data}`);
              
              if (message.status_code === Soup.Status.OK) {
                  const jsonResponse = JSON.parse(data);
  
                  log(`[DockSwipeTracker] Parsed Response: ${JSON.stringify(jsonResponse)}`);
  
                  // Parse total time
                  if (typeof jsonResponse.totalHours === 'string' && jsonResponse.totalHours.includes(':')) {
                      const timeParts = jsonResponse.totalHours.split(':');
                      const hours = parseInt(timeParts[0]);
                      const minutes = parseInt(timeParts[1]);
                      this._totalTime = hours + (minutes / 60);
                      this._totalTime = this._totalTime.toFixed(1);
                  } else {
                      this._totalTime = parseFloat(jsonResponse.totalHours).toFixed(1);
                  }
                  
                  if (isNaN(this._totalTime)) {
                      this._totalTime = 0;
                  }

                  this._status = jsonResponse.currentStatus;
                  this._estimatedCompletionTime = jsonResponse.estimatedCompletionTime || "N/A";
                  this._bufferTime = jsonResponse.bufferTime || "N/A";
                  this._targetEndTime = jsonResponse.targetEndTime || "18:30";
                  this._inTime = jsonResponse.inTime || "--:--";
                  this._lastOut = jsonResponse.lastOut || "--:--";
                  this._lastUpdate = new Date();
                  
                  this._updateUI();
                  
                  // Animation effect
                  this.panelContainer.ease({
                      scale_x: 1.05,
                      scale_y: 1.05,
                      duration: 150,
                      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                      onComplete: () => {
                          this.panelContainer.ease({
                              scale_x: 1.0,
                              scale_y: 1.0,
                              duration: 100,
                              mode: Clutter.AnimationMode.EASE_OUT_QUAD
                          });
                      }
                  });
              } else {
                  log(`[DockSwipeTracker] Failed to fetch data. Status Code: ${message.status_code}`);
              }
          } catch (e) {
              logError(e, 'DockSwipeTracker - Error in fetching data');
          }
      });

      // Also fetch weekly data
      this._fetchWeeklyData();
    }

    destroy() {
      if (this._timeoutId) {
        GLib.source_remove(this._timeoutId);
      }

      if (this._stylesheet) {
        let theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        theme.unload_stylesheet(this._stylesheet);
      }

      super.destroy();
    }
  }
);

function init() {
  ExtensionUtils.initTranslations(GETTEXT_DOMAIN);
}

function enable() {
  extension = new DockSwipeTracker();
  Main.panel.addToStatusArea("dock-swipe-tracker", extension);
}

function disable() {
  if (extension) {
    extension.destroy();
    extension = null;
  }
}