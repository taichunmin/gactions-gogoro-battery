const {
  BrowseCarousel,
  BrowseCarouselItem,
  dialogflow,
  Image,
  Permission,
} = require('actions-on-google')
const _ = require('lodash')
const { sin, cos, PI, atan2, sqrt } = Math
const axios = require('axios')
const csvParse = require('csv-parse')
const functions = require('firebase-functions')
const Qs = require('qs')
const uuidv4 = require('uuid/v4')

const app = dialogflow({ debug: true })
const DISTANCE_PER_DEGREE = 111194.92664455874 // 經緯度每一度的大約距離（單位：公尺）
const EARTH_RADIUS = 6371e3 // 地球的半徑（單位：公尺）
const NEARBY_DISTANCE = 5000 // 多少距離才能算是附近（單位：公尺）

/**
 * 取得 process.env.[key] 的輔助函式，且可以有預設值
 */
const getenv = (key, defaultval) => {
  return _.get(process, ['env', key], defaultval)
}

const NEARBY_DEGREE = NEARBY_DISTANCE / DISTANCE_PER_DEGREE // 多少經緯度內才能算是附近

const GA_DEFAULTS = {
  aip: 1, // 忽略追蹤發送者 IP
  an: 'GOGORO 換電站', // App Name
  av: require('./package.json').version,
  de: 'UTF-8', // chatset
  ds: 'app', // data source: web, app, or custom
  tid: getenv('GA_MEASUREMENT_ID', 'UA-154684534-1'),
  ul: 'zh-tw', // locale
  v: 1, // api version
}

const degreeToRad = (x) => x * PI / 180.0

const haversineDistance = (aLat, aLng, bLat, bLng) => {
  const dLat = degreeToRad(bLat - aLat)
  const dLng = degreeToRad(bLng - aLng)

  const f = sin(dLat / 2) ** 2 + cos(degreeToRad(aLat)) * cos(degreeToRad(bLat)) * sin(dLng / 2) ** 2
  const c = 2 * atan2(sqrt(f), sqrt(1 - f))
  return EARTH_RADIUS * c
}

const isBetween = (number, start, end) => start < end ? (start <= number && number <= end) : (end <= number && number <= start)

const parseCsv = csv => new Promise((resolve, reject) => {
  csvParse(csv, {
    columns: true,
    skip_empty_lines: true,
  }, (err, output) => err ? reject(err) : resolve(output))
})

const getBatterys = async () => {
  const res = await axios.get('https://storage.googleapis.com/storage-gogoro.taichunmin.idv.tw/data/gogoro-battery.csv')
  return await parseCsv(res.data)
}

const httpBuildQuery = obj => Qs.stringify(obj, { arrayFormat: 'brackets' })

const stationGoogleMapUrl = s => {
  const baseUrl = 'https://www.google.com/maps/search/?'
  const query = {
    api: 1,
    query: `${s.lat},${s.lng}`
  }
  if (_.isString(s.place_id) && s.place_id) query.query_place_id = s.place_id
  return baseUrl + httpBuildQuery(query)
}

const renderBatteryBrowseCarousel = batterys => {
  const items = _.map(batterys, s => new BrowseCarouselItem({
    title: s.name,
    url: stationGoogleMapUrl(s),
    description: s.address,
    footer: '點此開啟 Google 導航',
    image: new Image({
      url: 'https://i.imgur.com/FPLafsz.png',
      alt: 'Google Maps',
    }),
  }))
  return new BrowseCarousel({ items })
}

const getConvAbility = conv => ({
  screen: conv.screen,
  audio: conv.surface.capabilities.has('actions.capability.AUDIO_OUTPUT'),
  media: conv.surface.capabilities.has('actions.capability.MEDIA_RESPONSE_AUDIO'),
  browser: conv.surface.capabilities.has('actions.capability.WEB_BROWSER'),
  canvas: conv.surface.capabilities.has('actions.capability.INTERACTIVE_CANVAS'),
})

const sessGet = (conv, key, defaultVal) => {
  if (_.get(conv, 'user.verification') === 'VERIFIED') {
    return _.get(conv.user.storage, key, defaultVal)
  } else {
    return _.get(conv.data, key, defaultVal)
  }
}

const sessSet = (conv, key, newVal) => {
  if (_.get(conv, 'user.verification') === 'VERIFIED') {
    _.set(conv.user.storage, key, newVal)
  } else {
    _.set(conv.data, key, newVal)
  }
  return newVal
}

const sessHas = (conv, key) => {
  if (_.get(conv, 'user.verification') === 'VERIFIED') {
    return _.hasIn(conv.user.storage, key)
  } else {
    return _.hasIn(conv.data, key)
  }
}

/**
 * 送出 screenview
 * @param {Object} payload
 * @param {String} payload.cd (Required) Screen Name
 */
const gaScreenView = async (conv, screenName) => {
  if (!sessHas(conv, 'cid')) sessSet(conv, 'cid', uuidv4())
  await axios.post('https://www.google-analytics.com/collect', httpBuildQuery({
    ...GA_DEFAULTS,
    cid: sessGet(conv, 'cid'), // client_id
    t: 'screenview',
    cd: screenName
  }))
}

/**
 * 送出 event，建議要在 screenview 或是 pageview 之後送出，否則很有可能會因為無法被歸類在工作階段中而被忽略。
 * @param {Object} payload
 * @param {String} payload.ec (Required) 事件類別，如：「影片」
 * @param {String} payload.ea (Required) 事件動作，如：「播放」，相同的事件動作會被去重複
 * @param {String} payload.el (Optional) 事件標籤，如：「亂世佳人」
 * @param {Unsigned} payload.ev (Optional) 事件數值，非負整數
 * @see https://developers.google.com/analytics/devguides/collection/protocol/v1/parameters#events
 * @see https://support.google.com/analytics/answer/1033068
 */
const gaEvent = async (conv, payload) => {
  if (!sessHas(conv, 'cid')) sessSet(conv, 'cid', uuidv4())
  await axios.post('https://www.google-analytics.com/collect', httpBuildQuery({
    ...GA_DEFAULTS,
    cid: sessGet(conv, 'cid'), // client_id
    t: 'event',
    ...payload
  }))
}

app.intent('附近的換電站詢問地點', async conv => {
  if (_.get(conv, 'user.verification') !== 'VERIFIED') {
    conv.close('很抱歉，由於您目前是訪客身份，所以無法取得您的定位資訊，請於 Google 助理登入後再試一次。')
    await gaScreenView(conv, '無法取得定位/訪客')
    return
  }
  conv.ask(new Permission({
    context: '為了要查詢附近的 GOGORO 換電站',
    permissions: ['DEVICE_PRECISE_LOCATION']
  }))
  await gaScreenView(conv, '附近的換電站詢問地點')
})

app.intent('附近的換電站結果', async (conv, params, granted) => {
  const ability = getConvAbility(conv)
  const { latitude: lat, longitude: lng } = _.get(conv, 'device.location.coordinates', {})
  if (!granted || !lat || !lng) {
    conv.close('很抱歉，沒辦法取得您的定位資訊。')
    await gaScreenView(conv, '無法取得定位/用戶未授權')
    return
  }
  await gaEvent(conv, { ec: '附近的換電站結果', ea: '裝置位置', el: JSON.stringify(_.get(conv, 'device.location')) })
  let batterys = _.filter(await getBatterys(), s => s.state === '1' && isBetween(s.lat, lat - NEARBY_DEGREE, lat + NEARBY_DEGREE) && isBetween(s.lng, lng - NEARBY_DEGREE, lng + NEARBY_DEGREE))
  _.each(batterys, s => {
    s.distance = haversineDistance(lat, lng, s.lat, s.lng)
  })
  batterys = _.slice(_.sortBy(_.filter(batterys, s => s.distance <= NEARBY_DISTANCE), ['distance']), 0, 3)
  const battry = _.head(batterys)
  if (!battry) {
    conv.close('很抱歉，在附近沒有 GOGORO 的換電站。')
    await gaScreenView(conv, '附近換電站/查無結果')
    return
  }
  // 回覆結果文字
  conv.close(`離您最近的 GOGORO 換電站是「${battry.name}」，直線距離約 ${_.round(battry.distance)} 公尺。`)
  // 顯示附近站點的導航
  if (ability.browser && batterys.length > 1) conv.close(renderBatteryBrowseCarousel(batterys))
  await gaScreenView(conv, '附近換電站/查詢成功')
  await gaEvent(conv, { ec: '附近的換電站結果', ea: '查詢結果', el: JSON.stringify(battry) })
})

exports.dialogflowFirebaseFulfillment = functions.https.onRequest(app)
