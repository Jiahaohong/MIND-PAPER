const { BrowserWindow } = require('electron');

const createMainWindow = ({ isDev, devServerURL, preloadPath, indexHtmlPath }) => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#f5f5f5',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (isDev) {
    win.loadURL(devServerURL);
  } else {
    win.loadFile(indexHtmlPath);
  }

  return win;
};

module.exports = {
  createMainWindow
};
