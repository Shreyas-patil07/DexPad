module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'DexPad',
    name: 'DexPad'
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: { name: 'dexpad' }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32']
    }
  ]
};
