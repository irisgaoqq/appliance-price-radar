# Retailer Feed Drop Folder

Place merchant, affiliate, or approved retailer CSV exports in this folder, then use the page's "导入文件夹" button or call:

```powershell
Invoke-WebRequest -Uri 'http://localhost:8113/api/import-feeds' -Method POST -ContentType 'application/json' -Body '{}'
```

Each CSV file should use this header shape:

```csv
retailer,title,price,url,stock,wasPrice,sku
```

The importer scans every `.csv` file in this folder, matches rows to tracked products by brand, model, model code, and spec words, applies high-confidence matches, and sends uncertain rows to the pending match queue.
