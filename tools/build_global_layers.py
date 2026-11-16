#!/usr/bin/env python3
"""Build frozen NASA EIC layers; no physics/contract source modifications.
Run with Python + numpy/scipy/Pillow. Geographic NOx provenance: SVS5518 explicitly
equirectangular. Wind remains image-space: SVS5148 does not state projection.
"""
from pathlib import Path
import gzip, hashlib, json, importlib.util
import numpy as np
from PIL import Image
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('eic',ROOT/'tools/eic_frames.py');eic=importlib.util.module_from_spec(spec);spec.loader.exec_module(eic)
CONFIG={
 'nox-global':dict(name='Global nitrogen oxides (NOx)',units='ppbv',lo=.001,hi=10.,kind='log',source='https://svs.gsfc.nasa.gov/5518/',date='2024-07-01',grid='geo',bar_xy=(108,499,94),mask=[],source_frame_url='https://svs.gsfc.nasa.gov/vis/a000000/a005500/a005518/frames/2048x1024_2x1_30p/NitrogenOxides_Layer/AirQuality_NOx_Layer_2048x1024_0000.png',note='GEOS-CF modeled near-surface NO + NO2, not observed tropospheric NO2 or AQI. Date from row 1 of the published dates.txt. SVS5518 states equirectangular content.'),
 'wind-global':dict(name='Global near-surface wind speed',units='m/s',lo=0.,hi=40.,kind='linear',source='https://svs.gsfc.nasa.gov/5148/',date='2026-10-30T05:00:00-04:00',grid='image',bar_xy=(74,462,89),mask=[(0,0,360,80),(0,950,520,1024)],source_frame_url='https://svs.gsfc.nasa.gov/vis/a000000/a005100/a005148/frames/2048x1024_2x1_12p/MC02_stage3_GMAO_near_surface_wind_2048x1024_en-hwtool/00000001.png',note='GEOS-FP modeled 10-m wind speed. Timestamp read from the downloaded frame. Whole-frame image grid: geographic extent/projection not asserted by this source page. Neutral colors conservatively discarded because grey basemap can be confused with high-end bar colors.'),
}
def build(key,c):
 out=ROOT/'data'/key;out.mkdir(exist_ok=True)
 source=ROOT/'data/frames'/f'{key}.png';barfile=ROOT/'data/frames'/f'bar_{key}.png'
 im=np.asarray(Image.open(source).convert('RGB'),dtype=float)
 bi=np.asarray(Image.open(barfile).convert('RGB'),dtype=float)
 x0,x1,y=c['bar_xy'];ramp=bi[y,x0:x1+1]
 bar=eic.ColourBar(ramp,c['lo'],c['hi'])
 # The displayed colorbar law is independent of the fixed-tone audio contract.
 bar.values=(np.geomspace(c['lo'],c['hi'],len(ramp)) if c['kind']=='log' else np.linspace(c['lo'],c['hi'],len(ramp)))
 mean_err,max_err=bar.round_trip()
 usable=(ramp.max(axis=1)-ramp.min(axis=1))>18
 back,_=bar.invert(ramp[usable]);usable_err=np.abs(back-bar.values[usable])
 values,dist=bar.invert(im)
 # Neutral basemap, coastlines and high-end grayscale pixels are ambiguous:
 # discard rather than interpreting them as measurements.
 chroma=im.max(axis=2)-im.min(axis=2)
 observed=(dist<.025)&(chroma>18)
 for l,t,r,b in c['mask']:observed[t:b,l:r]=False
 grid=eic.canonical_grid() if c['grid']=='geo' else eic.image_grid(90,180)
 vals,counts=(eic.resample(values,observed,[-90,90,-180,180]) if c['grid']=='geo' else eic.resample_image(values,observed,grid))
 valid=counts>=3
 quantum=(c['hi']-c['lo'])/30000
 field=np.where(valid,np.rint((vals-c['lo'])/quantum),eic.FILL).astype('<i2')[None,...]
 defs=eic.DEFAULT_REGIONS if c['grid']=='geo' else eic.IMAGE_REGIONS
 masks=eic.region_masks(defs,grid);weights=eic.area_weights(grid)
 checks=eic.region_series(field,masks,weights,quantum,c['lo'],'scan-lat',grid['nlat'])
 blob=gzip.compress(field.tobytes(),compresslevel=9,mtime=0);(out/'field.i16.gz').write_bytes(blob)
 land=(ROOT/'data/sst/landfrac.u8').read_bytes() if c['grid']=='geo' else bytes(16200)
 (out/'landfrac.u8').write_bytes(land)
 balance=(c['lo']+c['hi'])/2;slope=30/(c['hi']-c['lo'])
 regions={'note':'Geographic area weighting only where projection is documented; image rows use uniform weights.','regions':[{'id':d['id'],'label':d['label'],'slope':slope,'requested_bounds':{'lat':d['lat'],'lon':d['lon']},'bounds':{'lat':d['lat'],'lon':d['lon']},'cells':int(masks[d['id']].sum())} for d in defs]}
 (out/'regions.json').write_text(json.dumps(regions,indent=2)+'\n')
 flat=field.ravel();cov=float(weights[valid].sum()/weights.sum())
 meta={'schema':1,'generated':'2026-11-15','dataset':{'name':c['name'],'attribution':"NASA Global Modeling and Assimilation Office / Scientific Visualization Studio",'source_url':c['source'],'source_frame_url':c['source_frame_url'],'source_date':c['date'],'units':c['units'],'colour_bar':barfile.name,'colour_bar_sha256':hashlib.sha256(barfile.read_bytes()).hexdigest(),'colour_bar_sample':{'x0':x0,'x1':x1,'y':y,'note':'Inclusive interior color-strip pixels, excluding border and text.'},'colour_bar_range':[c['lo'],c['hi']],'colour_bar_kind':c['kind'],'derivation':c['note'],'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'inversion_error':{'mean':mean_err,'max':max_err,'usable_mean':float(usable_err.mean()),'usable_max':float(usable_err.max()),'note':'Published ramp round-trip ambiguity only; not model uncertainty or per-frame scientific accuracy.'}},'contract':{'slope':slope,'balance_at':balance,'units':c['units'],'note':'Fixed-tone physical-value contract spans 30dB across the published physical range; colorbar law handled before averaging.'},'grid':grid,'axis':{'kind':'scan-lat','note':'One frozen source frame swept top to bottom; not a temporal series.'},'time':{'cadence':'frame','count':1,'frames':[source.name],'dates':[c['date']]},'field':{'file':'field.i16.gz','encoding':'gzip','dtype':'int16','endianness':'little','layout':'[frame][lat][lon], C order','scale_factor':quantum,'offset':c['lo'],'fill_value':eic.FILL,'bytes_gzipped':len(blob),'sha256':hashlib.sha256(blob).hexdigest()},'landfrac':{'file':'landfrac.u8','dtype':'uint8','scale':1/255,'layout':'[lat][lon], C order'},'coverage':[cov],'cells_observed':[int(valid.sum())],'threshold':.025,'min_pixels':3,'threshold_note':'OKLab distance <0.025 and RGB chroma >18; neutral/ambiguous pixels, timestamp and logo regions excluded. Missing is silent, not zero.','geo':[-90,90,-180,180] if c['grid']=='geo' else None,'crop':None,'verification':{'tolerance':1e-6,'probes':[{'index':int(i),'raw':int(flat[i])} for i in [len(flat)//7,len(flat)//3,len(flat)-1]],'regions':checks}}
 (out/'meta.json').write_text(json.dumps(meta,indent=2)+'\n')
 palette={'lo':c['lo'],'hi':c['hi'],'kind':c['kind'],'colors':['#'+''.join(f'{int(v):02x}' for v in rgb) for rgb in ramp],'positions':bar.values.tolist(),'units':c['units']}
 (out/'palette.json').write_text(json.dumps(palette)+'\n')
 # Independent checks on written bytes, bounds, non-empty coverage and log law.
 decoded=np.frombuffer(gzip.decompress((out/'field.i16.gz').read_bytes()),dtype='<i2').reshape(1,90,180)
 assert np.array_equal(decoded,field)
 assert valid.sum()>1000 and np.all((decoded[decoded!=eic.FILL]>=0)&(decoded[decoded!=eic.FILL]<=30000))
 if c['kind']=='log':assert np.isclose(bar.values[len(ramp)//2],np.sqrt(c['lo']*c['hi']),rtol=.02)
 print(key,'coverage',round(cov,4),'valid_cells',int(valid.sum()),'bar_roundtrip',mean_err,max_err,'contract',slope,balance)
for key,c in CONFIG.items():build(key,c)
