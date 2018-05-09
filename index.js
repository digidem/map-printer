var yo = require('yo-yo')
var mapStream = require('mapbox-map-image-stream')
var streamsaver = require('streamsaver')

var settings = JSON.parse(window.localStorage.getItem('map-export-settings')) || {
  style: 'mapbox://styles/mapbox/streets-v9',
  width: 297,
  height: 210,
  bbox: [-7.1354, 57.9095, -6.1357, 58.516]
}

function getProgress (pct, hidden) {
  var text = pct ? 'Exporting ' + Math.floor(pct) + '%' : 'Preparing...'
  var width = pct || 100
  return yo`<div style="display: ${hidden ? 'none' : 'block'}">
    <p>${text}</p>
    <div class="progress ${pct ? '' : 'progress-bar-striped progress-bar-animated'}">
      <div class="progress-bar" role="progressbar" style="width: ${width}%" aria-valuenow="${width}" aria-valuemin="0" aria-valuemax="100"></div>
    </div>
  </div>`
}

var progress = window.progress = getProgress(0, true)

var button = yo`<button type="submit" class="btn btn-primary" onclick="${onExportClick}">Export Image</button>`

var form = yo`<form>
<div class="form-group">
  <label for="token">Mapbox Token</label>
  <input type="text" class="form-control" id="token" onblur="${onblur}" placeholder="Enter Mapbox Public Token" value="${settings.token || ''}">
</div>
<div class="form-group">
  <label for="style">Mapbox Style URL</label>
  <input type="text" class="form-control" id="style" onblur="${onblur}" value="${settings.style || ''}">
</div>
<div class="form-group">
  <label for="width">Page width (mm)</label>
  <input type="number" class="form-control" id="width" onblur="${onblur}" value="${settings.width}">
</div>
<div class="form-group">
  <label for="height">Page height (mm)</label>
  <input type="number" class="form-control" id="height" onblur="${onblur}" value="${settings.height}">
</div>
<div class="form-group">
  <label for="west">West Longitude</label>
  <input type="number" class="form-control" id="west" onblur="${onblur}" value="${settings.bbox[0]}" step="0.001">
</div>
<div class="form-group">
  <label for="south">South Latitude</label>
  <input type="number" class="form-control" id="south" onblur="${onblur}" value="${settings.bbox[1]}" step="0.001">
</div>
<div class="form-group">
  <label for="east">East Longitude</label>
  <input type="number" class="form-control" id="east" onblur="${onblur}" value="${settings.bbox[2]}" step="0.001">
</div>
<div class="form-group">
  <label for="north">North Longitude</label>
  <input type="number" class="form-control" id="north" onblur="${onblur}" value="${settings.bbox[3]}" step="0.001">
</div>
<div class="form-group">
  <label for="dpi">Export resolution</label>
  <select class="custom-select" id="dpi" onchange="${onblur}">
    <option ${settings.dpi === 96 ? 'selected' : ''} value="96">96dpi</option>
    <option ${settings.dpi === 192 ? 'selected' : ''} value="192">192dpi</option>
    <option ${settings.dpi === 288 ? 'selected' : ''} value="288">288dpi</option>
  </select>
</div>
${progress}
${button}
</form>`

var mapDiv = renderMapDiv(['100%', '100%'])



function renderMapDiv ([width, height]) {
  return yo`<div style="background-color: #cccccc; width: ${width}; height: ${height}">Map will be here</div>`
}

form.addEventListener('blur', () => console.log('blur'), true)

function onblur () {
  settings = {
    token: form.token.value,
    style: form.style.value,
    bbox: [
      form.west.valueAsNumber,
      form.south.valueAsNumber,
      form.east.valueAsNumber,
      form.north.valueAsNumber
    ],
    dpi: Number.parseInt(form.dpi.value),
    width: form.width.valueAsNumber,
    height: form.height.valueAsNumber
  }
  window.localStorage.setItem('map-export-settings', JSON.stringify(settings))
}

progress.querySelector('.progress-bar').style.transition = 'none'

function onExportClick (e) {
  e.preventDefault()
  button.style.display = 'none'
  yo.update(progress, getProgress(0))
  var downloadStream = streamsaver.createWriteStream('map.png')
  let writer = downloadStream.getWriter()
  var mapDiv = document.getElementById('map')
  var opts = Object.assign({}, settings, {
    bbox: settings.bbox.join(','),
    width: settings.width + 'mm',
    height: settings.height + 'mm'
  })
  mapStream(settings.style, mapDiv, opts)
    .on('data', data => writer.write(data))
    .on('progress', pct => yo.update(progress, getProgress(Math.floor(pct * 100))))
    .on('end', () => writer.close())
}

document.getElementById('left').appendChild(form)
document.getElementById('right').appendChild(mapDiv)
