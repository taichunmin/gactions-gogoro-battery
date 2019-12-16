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

const app = dialogflow()
const DISTANCE_PER_DEGREE = 111194.92664455874 // 經緯度每一度的大約距離（單位：公尺）
const EARTH_RADIUS = 6371e3 // 地球的半徑（單位：公尺）
const NEARBY_DISTANCE = 5000 // 多少距離才能算是附近（單位：公尺）

const NEARBY_DEGREE = NEARBY_DISTANCE / DISTANCE_PER_DEGREE // 多少經緯度內才能算是附近

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

app.intent('附近的換電站詢問地點', async conv => {
  if (_.get(conv, 'user.verification') !== 'VERIFIED') {
    conv.close('很抱歉，您目前是訪客身份，所以沒辦法取得您的定位資訊。')
    return
  }
  conv.ask(new Permission({
    context: '為了要查詢附近的 GOGORO 換電站',
    permissions: ['DEVICE_PRECISE_LOCATION']
  }))
})

app.intent('附近的換電站結果', async (conv, params, granted) => {
  const ability = getConvAbility(conv)
  const { latitude: lat, longitude: lng } = _.get(conv, 'device.location.coordinates', {})
  if (!granted || !lat || !lng) {
    conv.close('很抱歉，沒辦法取得您的定位資訊。')
    return
  }
  let batterys = _.filter(await getBatterys(), s => isBetween(s.lat, lat - NEARBY_DEGREE, lat + NEARBY_DEGREE) && isBetween(s.lng, lng - NEARBY_DEGREE, lng + NEARBY_DEGREE))
  _.each(batterys, s => {
    s.distance = haversineDistance(lat, lng, s.lat, s.lng)
  })
  batterys = _.slice(_.sortBy(_.filter(batterys, s => s.distance <= NEARBY_DISTANCE), ['distance']), 0, 3)
  const battry = _.head(batterys)
  if (!battry) {
    conv.close('很抱歉，在附近沒有 GOGORO 的換電站。')
    return
  }
  // 回覆結果文字
  conv.close(`離您最近的 GOGORO 換電站是「${battry.name}」，直線距離約 ${_.round(battry.distance)} 公尺。`)
  // 顯示附近站點的導航
  if (ability.browser && batterys.length > 1) conv.close(renderBatteryBrowseCarousel(batterys))
})

exports.dialogflowFirebaseFulfillment = functions.https.onRequest(app)
