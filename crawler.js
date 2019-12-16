const _ = require('lodash')
const axios = require('axios')
const csvStringify = require('csv-stringify')

/**
 * 取得 process.env.[key] 的輔助函式，且可以有預設值
 */
exports.getenv = (key, defaultval) => {
  return _.get(process, ['env', key], defaultval)
}

exports.batteryParser = battery => {
  try {
    _.each(['LocName', 'Address', 'District', 'City'], key => {
      battery[key] = JSON.parse(battery[key])
    })
    return {
      id: _.get(battery, 'Id'),
      name: _.get(_.find(battery.LocName.List, ['Lang', 'zh-TW']), 'Value'),
      lat: _.get(battery, 'Latitude'),
      lng: _.get(battery, 'Longitude'),
      address: _.get(_.find(battery.Address.List, ['Lang', 'zh-TW']), 'Value'),
      district: _.get(_.find(battery.District.List, ['Lang', 'zh-TW']), 'Value'),
      city: _.get(_.find(battery.City.List, ['Lang', 'zh-TW']), 'Value'),
      state: _.get(battery, 'State')
    }
  } catch (err) {
    console.log(err)
  }
}

exports.csvStringify = records => new Promise((resolve, reject) => {
  csvStringify(records, {
    header: true,
  }, (err, output) => err ? reject(err) : resolve(output))
})

exports.getBatterys = async () => {
  try {
    const BATTERY_API = 'https://webapi.gogoro.com/api/vm/list'
    // const BATTERY_API = 'https://storage.googleapis.com/storage-gogoro.taichunmin.idv.tw/data/gogoro-battery.json'
    const res = await axios.get(BATTERY_API)
    return _.map(res.data, exports.batteryParser)
  } catch (err) {
    console.log(err)
  }
}

exports.gcsJsonUpload = async (dest, data, maxAge = 30) => {
  const { Storage } = require('@google-cloud/storage')
  const storage = new Storage()
  const bucket = storage.bucket(exports.getenv('GCS_BUCKET'))
  const file = bucket.file(dest)
  await file.save(data, {
    gzip: true,
    // public: true,
    validation: 'crc32c',
    metadata: {
      cacheControl: `public, max-age=${maxAge}`,
      contentLanguage: 'zh',
      contentType: 'application/json'
    }
  })
}

exports.gcsCsvUpload = async (dest, data, maxAge = 30) => {
  const { Storage } = require('@google-cloud/storage')
  const storage = new Storage()
  const bucket = storage.bucket(exports.getenv('GCS_BUCKET'))
  const file = bucket.file(dest)
  await file.save(data, {
    gzip: true,
    // public: true,
    validation: 'crc32c',
    metadata: {
      cacheControl: `public, max-age=${maxAge}`,
      contentLanguage: 'zh',
      contentType: 'text/csv'
    }
  })
}

exports.main = async (data, context) => {
  try {
    const batterys = await exports.getBatterys()
    await exports.gcsCsvUpload('data/gogoro-battery.csv', await exports.csvStringify(batterys))
  } catch (err) {
    console.log(err)
  }
}
