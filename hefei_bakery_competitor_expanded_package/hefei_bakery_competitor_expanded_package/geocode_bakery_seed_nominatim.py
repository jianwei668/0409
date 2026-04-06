#!/usr/bin/env python3
import csv, json, time, urllib.parse, urllib.request
from pathlib import Path

def geocode(query: str):
    url = 'https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode({
        'q': query,
        'format': 'jsonv2',
        'limit': 1
    })
    req = urllib.request.Request(url, headers={'User-Agent': 'chatgpt-geocoder/1.0'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode('utf-8'))

def main(input_csv='bakery_competitor_geocode_seed.csv', output_csv='bakery_competitor_geocoded.csv'):
    rows=[]
    with open(input_csv, 'r', encoding='utf-8-sig') as f:
        reader=csv.DictReader(f)
        for row in reader:
            q = f"{row['store_name']} {row['address']} 合肥 安徽 中国"
            try:
                res = geocode(q)
                if res:
                    row['longitude_wgs84']=res[0]['lon']
                    row['latitude_wgs84']=res[0]['lat']
                else:
                    row['longitude_wgs84']=''
                    row['latitude_wgs84']=''
            except Exception:
                row['longitude_wgs84']=''
                row['latitude_wgs84']=''
            rows.append(row)
            time.sleep(1.2)
    with open(output_csv,'w',newline='',encoding='utf-8-sig') as f:
        writer=csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader(); writer.writerows(rows)

if __name__ == '__main__':
    import sys
    in_csv = sys.argv[1] if len(sys.argv) > 1 else 'bakery_competitor_geocode_seed.csv'
    out_csv = sys.argv[2] if len(sys.argv) > 2 else 'bakery_competitor_geocoded.csv'
    main(in_csv, out_csv)
