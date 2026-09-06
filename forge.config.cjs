module.exports = {
  packagerConfig: {
    asar: true,
    // note: koffi ships prebuilt native binaries (.node/.dll) that cannot be
    // dlopen'd from inside an asar archive. asarUnpack extracts them to
    // app.asar.unpacked/ so require('koffi') works in installed builds.
    asarUnpack: ['**/node_modules/koffi/**'],
    executableName: 'DexPad',
    name: 'DexPad',
    icon: './assets/icon'
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'dexpad',
        setupIcon: './assets/icon.ico'
      }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32']
    }
  ]
};
