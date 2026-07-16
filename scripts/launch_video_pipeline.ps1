$py     = 'C:\Users\Derek DiCamillo\AppData\Local\Programs\Python\Python312\python.exe'
$script = 'C:\Users\Derek DiCamillo\Projects\atlas\scripts\video_pipeline.py'
$outdir = 'C:\Users\Derek DiCamillo\Projects\atlas\docs\knowledge\functional-medicine\_video-transcripts'
New-Item -ItemType Directory -Force -Path $outdir | Out-Null
$out = Join-Path $outdir 'launch_out.log'
$err = Join-Path $outdir 'launch_err.log'
$p = Start-Process -FilePath $py -ArgumentList "`"$script`"" -WindowStyle Hidden `
      -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
Write-Output ("launched pid " + $p.Id)
