var yo = require('yo-yo')
var mapStream = require('mapbox-map-image-stream')
var mapboxgl = require('mapbox-gl')
var bboxPolygon = require('@turf/bbox-polygon').default
var fc = require('@turf/helpers').featureCollection
var fitBounds = require('viewport-mercator-project').fitBounds
var store = require('browser-cache-blob-store')
var pump = require('pump')

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .then(function (reg) {
    // registration worked
      console.log('Registration succeeded. Scope is ' + reg.scope)
    }).catch(function (error) {
    // registration failed
      console.log('Registration failed with ' + error)
    })
}

var isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
if (!('caches' in window) || typeof ReadableStream === 'undefined' || isSafari) {
  document.body.classList.add('unsupported')
}

var settings = JSON.parse(window.localStorage.getItem('map-export-settings')) || {
  style: 'mapbox://styles/mapbox/streets-v9',
  width: 297,
  height: 210,
  bbox: [-7.1354, 57.9095, -6.1357, 58.516],
  previewBbox: true
}

const bboxLayer = {
  'id': 'bbox',
  'type': 'line',
  'source': 'bbox',
  'layout': {
    'line-join': 'miter'
  },
  'paint': {
    'line-color': 'rgb(255, 0, 0)',
    'line-opacity': 0.8,
    'line-width': 1,
    'line-dasharray': [3, 3]
  }
}

var mapContainer = document.getElementById('right')
var mapDiv = document.getElementById('map')
var mapZoomPreview = yo`<span></span>`
var nav = new mapboxgl.NavigationControl({ showCompass: false })
var map
var lastStyle = settings.style

window.addEventListener('resize', updateMap)

function updateMap () {
  var rect = mapContainer.getBoundingClientRect()
  var paperAspect = settings.width / settings.height
  var mapDivAspect = rect.width / rect.height
  if (paperAspect > mapDivAspect) {
    mapDiv.style.width = rect.width + 'px'
    mapDiv.style.height = rect.width / paperAspect + 'px'
  } else {
    mapDiv.style.width = rect.height * paperAspect + 'px'
    mapDiv.style.height = rect.height + 'px'
  }
  if (!map) {
    mapboxgl.accessToken = settings.token
    map = new mapboxgl.Map({
      container: mapDiv,
      style: settings.style,
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: false
    })
    map.addControl(nav, 'top-left')
    map.fitBounds(bboxToBounds(settings.bbox), { duration: 0 })
    map.on('load', () => {
      updateMap()
    })
    map.on('styledata', () => {
      form.token.classList.remove('is-invalid')
      form.style.classList.remove('is-invalid')
      if (map.getSource('bbox')) return
      map.addSource('bbox', { type: 'geojson', data: fc([]) })
      map.addLayer(bboxLayer)
    })
    map.on('error', e => {
      switch (e.error.status) {
        case 401:
          form.token.classList.add('is-invalid')
          break
        case 404:
          form.style.classList.add('is-invalid')
          break
        default:
          console.log(e)
      }
      map.remove()
      map = null
    })
  }
  map.resize()
  if (settings.style !== lastStyle) {
    map.setStyle(settings.style)
    lastStyle = settings.style
  }
  if (!isValidBbox(settings.bbox)) {
    form.bbox.classList.add('is-invalid')
    return
  }
  form.bbox.classList.remove('is-invalid')
  if (map.getSource('bbox')) {
    map.getSource('bbox').setData(fc(
      settings.previewBbox ? [bboxPolygon(settings.bbox)] : []
    ))
  }
  var pxWidth = Math.ceil(settings.width / 25.4 * settings.dpi)
  var pxHeight = Math.ceil(settings.height / 25.4 * settings.dpi)
  var zoom = fitBounds({
    width: pxWidth * 96 / settings.dpi,
    height: pxHeight * 96 / settings.dpi,
    bounds: bboxToBounds(settings.bbox)
  }).zoom
  zoom = Math.round(zoom * 1000) / 1000
  mapZoomPreview = yo.update(
    mapZoomPreview,
    yo`<p>Map will export at <a href="#" onclick=${onClickZoom}>zoom ${zoom}</a>
      sized ${pxWidth}px x ${pxHeight}px
    </p>`
  )
  function onClickZoom () {
    map.flyTo({
      center: map.getCenter(),
      zoom: zoom
    })
  }
}

var submitButton = () => yo`<button type="submit" class="btn btn-primary" onclick="${exportMap}">Export Image</button>`
var action = submitButton()

var form = yo`<form>
<h1>Map Printer</h1>
<p>Export massive hi-res PNGs from <a href="https://www.mapbox.com/studio-manual/overview/map-styling/" target="_blank">Mapbox map styles</a>.</p>
<div class="form-group">
  <input type="text" class="form-control" id="token" onblur="${onblur}" placeholder="Enter Mapbox Public Token" value="${settings.token || ''}">
  <small class="form-text text-muted">
    <a href="https://www.mapbox.com/account/access-tokens" target="_blank">Mapbox access token</a>
  </small>
  <div class="invalid-feedback">
    It seems like this access token is invalid.
  </div>
</div>
<div class="form-group">
  <input type="text" class="form-control" id="style" onblur="${onblur}" placeholder="Enter mapbox style URL" value="${settings.style || ''}">
  <small class="form-text text-muted">
    <a href="https://www.mapbox.com/help/define-style-url/" target="_blank">Mapbox style url</a>
  </small>
  <div class="invalid-feedback">
    This style does not seem to work.
  </div>
</div>
<div class="form-row">
  <div class="col">
    <div class="form-group">
      <div class="input-group">
        <input type="number" class="form-control" id="width" onblur="${onblur}" value="${settings.width}">
        <div class="input-group-append">
          <span class="input-group-text">mm</span>
        </div>
      </div>
      <small class="form-text text-muted">
        Page width (mm)
      </small>
    </div>
  </div>
  <div class="col">
    <div class="form-group">
      <div class="input-group">
        <input type="number" class="form-control" id="height" onblur="${onblur}" value="${settings.height}">
        <div class="input-group-append">
          <span class="input-group-text">mm</span>
        </div>
      </div>
      <small class="form-text text-muted">
        Page height (mm)
      </small>
    </div>
  </div>
</div>
<div class="form-group">
  <input type="text" class="form-control" id="bbox" onblur="${onblur}" placeholder="Enter bounding box" value="${settings.bbox || ''}">
  <small class="form-text text-muted">
    Comma-separated coordinates for bounds fit within exported page: <pre style="display: inline;">West,South,East,North</pre>
  </small>
  <div class="invalid-feedback">
    Invalid bounding box, check you have the coordinate order correct
  </div>
</div>
<div class="form-check form-group">
  <input class="form-check-input" type="checkbox"  onchange="${onblur}" checked id="previewBbox">
  <label class="form-check-label" for="previewBbox">
    Preview bounding box (<a href="#" onclick="${zoomToBbox}">zoom to</a>)
  </label>
</div>
<div class="form-group">
  <select class="custom-select" id="dpi" onchange="${onblur}">
    <option ${settings.dpi === 96 ? 'selected' : ''} value="96">96dpi</option>
    <option ${settings.dpi === 192 ? 'selected' : ''} value="192">192dpi</option>
    <option ${settings.dpi === 288 ? 'selected' : ''} value="288">288dpi</option>
    <option ${settings.dpi === 384 ? 'selected' : ''} value="384">384dpi</option>
  </select>
  <small class="form-text text-muted">
    Target print DPI
  </small>
</div>
${mapZoomPreview}
${action}
</form>`

var renderProgress = (p) => {
  if (p == null) {
    return yo`<div class="progress" style="height: 20px;">
      <div class="progress-bar progress-bar-striped progress-bar-animated bg-info" role="progressbar" style="width: 100%; transision: none;" aria-valuenow="100" aria-valuemin="0" aria-valuemax="100"></div>
    </div>`
  } else {
    var value = Math.round(p * 100)
    return yo`<div class="progress" style="height: 20px;">
      <div class="progress-bar" role="progressbar" style="width: ${value}%; transition: none;" aria-valuenow="${value}" aria-valuemin="0" aria-valuemax="100"></div>
    </div>`
  }
}

function zoomToBbox (e) {
  e.preventDefault()
  map.fitBounds(bboxToBounds(settings.bbox))
}

function onblur () {
  settings = {
    token: form.token.value,
    style: form.style.value,
    bbox: form.bbox.value.split(/(?:,\s*)|(?:\s+)/g).map(parseFloat),
    previewBbox: form.previewBbox.checked,
    dpi: Number.parseInt(form.dpi.value),
    width: form.width.valueAsNumber,
    height: form.height.valueAsNumber
  }
  updateMap()
  window.localStorage.setItem('map-export-settings', JSON.stringify(settings))
}

var blobStore = store()

function exportMap (e) {
  e.preventDefault()
  action = yo.update(action, renderProgress(null))
  var width = settings.width / 25.4 * settings.dpi
  var height = settings.height / 25.4 * settings.dpi
  var ws = blobStore.createWriteStream('map.png', () => {
    var filename = `map-${JSON.stringify(settings.bbox)}-${settings.width}mmx${settings.height}mm-${settings.dpi}dpi.png`
    var downloadLink = yo`<a href="/export/${filename}"></a>`
    let click = new window.MouseEvent('click')
    downloadLink.dispatchEvent(click)
    action = yo.update(action, submitButton())
  })

  var maps = mapStream({
    token: settings.token,
    style: settings.style,
    bbox: settings.bbox,
    width: width,
    height: height,
    pixelRatio: settings.dpi / 96
  }).on('progress', p => {
    action = yo.update(action, renderProgress(p))
  })

  pump(maps, ws, function (err) {
    if (err) console.error(err)
  })
}

document.getElementById('left').appendChild(form)
updateMap()

function bboxToBounds (bbox) {
  return [[bbox[0], bbox[1]], [bbox[2], bbox[3]]]
}

function isValidBbox (b) {
  return Array.isArray(b) &&
    b.length === 4 &&
    b[0] < b[2] &&
    b[1] < b[3] &&
    b[0] >= -180 &&
    b[2] <= 180 &&
    b[1] >= -90 &&
    b[3] <= 90
}
