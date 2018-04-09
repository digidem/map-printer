var yo = require('yo-yo')
var mapStream = require('mapbox-map-image-stream')
var streamsaver = require('StreamSaver')

var form = yo`<form>
<div class="form-group">
  <label for="token">Mapbox Token</label>
  <input type="text" class="form-control" id="token" onblur="${onblur}" placeholder="Enter Mapbox Public Token">
</div>
<div class="form-group">
  <label for="style">Mapbox Style URL</label>
  <input type="text" class="form-control" id="style" onblur="${onblur}" value="mapbox://styles/mapbox/streets-v9">
</div>
<div class="form-group">
  <label for="width">Page width (mm)</label>
  <input type="number" class="form-control" id="width" onblur="${onblur}" value="297">
</div>
<div class="form-group">
  <label for="height">Page height (mm)</label>
  <input type="number" class="form-control" id="height" onblur="${onblur}" value="210">
</div>
<div class="form-group">
  <label for="west">West Longitude</label>
  <input type="number" class="form-control" id="west" onblur="${onblur}" value="-7.1354" step="0.001">
</div>
<div class="form-group">
  <label for="south">South Latitude</label>
  <input type="number" class="form-control" id="south" onblur="${onblur}" value="57.9095" step="0.001">
</div>
<div class="form-group">
  <label for="east">East Longitude</label>
  <input type="number" class="form-control" id="east" onblur="${onblur}" value="-6.1357" step="0.001">
</div>
<div class="form-group">
  <label for="north">North Longitude</label>
  <input type="number" class="form-control" id="north" onblur="${onblur}" value="58.516" step="0.001">
</div>
<div class="form-group">
  <label for="dpi">Export resolution</label>
  <select class="custom-select" id="dpi">
    <option value="96">96dpi</option>
    <option selected value="192">192dpi</option>
    <option value="288">288dpi</option>
  </select>
</div>
<button type="submit" class="btn btn-primary" onclick="${exportMap}">Export Image</button>
</form>`

function onblur () {
  console.log(form.dpi.value)
}

function exportMap (e) {
  e.preventDefault()
  var opts = {
    token: form.token.value,
    bbox: [
      form.west.valueAsNumber,
      form.south.valueAsNumber,
      form.east.valueAsNumber,
      form.north.valueAsNumber
    ].join(','),
    dpi: Number.parseInt(form.dpi.value),
    width: form.width.value + 'mm',
    height: form.height.value + 'mm'
  }
  var style = form.style.value
  var downloadStream = streamsaver.createWriteStream('map.png')
  let writer = downloadStream.getWriter()
  var mapDiv = document.getElementById('map')
  mapStream(style, mapDiv, opts)
    .on('data', data => writer.write(data))
    .on('progress', p => console.log(p))
    .on('end', () => writer.close())
}

document.getElementById('left').appendChild(form)
