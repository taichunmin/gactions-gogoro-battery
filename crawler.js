const _ = require('lodash')
const axios = require('axios')
const Papa = require('papaparse')

/**
 * 取得 process.env.[key] 的輔助函式，且可以有預設值
 */
exports.getenv = (key, defaultval) => {
  return _.get(process, ['env', key], defaultval)
}

exports.main = async () => {
  try {
    const batterys = await exports.getBatterys()
    await exports.gcsUpload({
      data: exports.unparseCsv(batterys),
      dest: 'data/gogoro-battery.csv',
    })
  } catch (err) {
    exports.log(err)
  }
}

exports.errToPlainObj = (() => {
  const ERROR_KEYS = [
    'address',
    'code',
    'data',
    'dest',
    'errno',
    'info',
    'message',
    'name',
    'path',
    'port',
    'reason',
    'response.data',
    'response.headers',
    'response.status',
    'stack',
    'status',
    'statusCode',
    'statusMessage',
    'syscall',
  ]
  return err => _.pick(err, ERROR_KEYS)
})()

exports.log = (() => {
  const LOG_SEVERITY = ['DEFAULT', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY']
  return (...args) => {
    let severity = 'DEFAULT'
    if (args.length > 1 && _.includes(LOG_SEVERITY, _.toUpper(args[0]))) severity = _.toUpper(args.shift())
    _.each(args, arg => {
      if (_.isString(arg)) arg = { message: arg }
      if (arg instanceof Error) arg = exports.errToPlainObj(arg)
      console.log(JSON.stringify({ severity, ...arg }))
    })
  }
})()

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
    exports.log(err)
  }
}

exports.unparseCsv = data => Papa.unparse(data, { header: true })

exports.getBatterys = async () => {
  try {
    const BATTERY_API = 'https://webapi.gogoro.com/api/vm/list'
    // const BATTERY_API = 'https://storage.googleapis.com/storage-gogoro.taichunmin.idv.tw/data/gogoro-battery.json'
    const res = await axios.get(BATTERY_API)
    return _.map(res.data, exports.batteryParser)
  } catch (err) {
    exports.log(err)
  }
}

exports.gcsUpload = (() => {
  const GCS_BUCKET = exports.getenv('GCS_BUCKET')
  if (!GCS_BUCKET) return () => { throw new Error('GCS_BUCKET is required') }

  const { Storage } = require('@google-cloud/storage')
  const storage = new Storage()
  const bucket = storage.bucket(GCS_BUCKET)
  return async ({ dest, data, contentType = 'text/csv; charset=utf-8', maxAge = 30 }) => {
    const file = bucket.file(dest)
    await file.save(data, {
      gzip: true,
      // public: true,
      validation: 'crc32c',
      metadata: {
        cacheControl: `public, max-age=${maxAge}`,
        contentLanguage: 'zh',
        contentType,
      },
    })
  }
})()
