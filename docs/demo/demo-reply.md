這幾步要你親手跑。先清掉 sudo 的密碼快取，再確認 sudo 能用：

```bash
sudo -k
sudo true
```

裝好套件後再啟動服務（約 30 秒）：

```bash
sudo pacman -S --needed nginx
sudo systemctl enable --now nginx
```

都好了再在提示框打 `! systemctl is-active nginx` 確認。
