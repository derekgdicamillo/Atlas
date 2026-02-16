$audioDir = "C:\Users\derek\Projects\atlas\data\training\brunson-ofa\audio"
$urls = @(
    @(4, "https://coursecast.herokuapp.com/download/32cc0cadefd3b21f0b787affba267f8b/aa758be71dc0a9b51560afb566f24c08"),
    @(5, "https://coursecast.herokuapp.com/download/32cc0cadefd3b21f0b787affba267f8b/3cf159073dcfe4525a00906caf860f33"),
    @(6, "https://coursecast.herokuapp.com/download/32cc0cadefd3b21f0b787affba267f8b/622c9c63e502828f33f171b19ff78f40"),
    @(7, "https://coursecast.herokuapp.com/download/32cc0cadefd3b21f0b787affba267f8b/1f61c75007be402bcd46796e64f7f932"),
    @(8, "https://coursecast.herokuapp.com/download/32cc0cadefd3b21f0b787affba267f8b/65e34fbcbfc072d5eaedc5d78ca062bd"),
    @(9, "https://coursecast.herokuapp.com/download/32cc0cadefd3b21f0b787affba267f8b/9576248275e401e4b9733af5f5ed69b0"),
    @(10, "https://coursecast.herokuapp.com/download/32cc0cadefd3b21f0b787affba267f8b/13256b0ae72590a75972b7c8b018e896")
)

foreach ($item in $urls) {
    $day = $item[0]
    $url = $item[1]
    $file = "$audioDir\day-$day.mp3"
    if ((Test-Path $file) -and (Get-Item $file).Length -gt 1000) {
        Write-Host "Day $day already downloaded"
        continue
    }
    Remove-Item $file -ErrorAction SilentlyContinue
    Write-Host "Downloading day $day..."
    Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
    $mb = [math]::Round((Get-Item $file).Length / 1MB, 1)
    Write-Host "Day $day done: $mb MB"
}
Write-Host "All downloads complete!"
