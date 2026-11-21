# Benchmarking Max on Kaggle (free)

`kaggle-max-humaneval.ipynb` runs all 164 HumanEval problems on Stellan-1 Max with the app's own settings. On Kaggle's free **GPU T4 x2** it should take roughly 1 to 3 hours; on the CPU it takes 12 hours or more.

## 1. The Google Drive saver (once, about 5 minutes)

Kaggle only keeps a run's files if it finishes on time. The saver copies the results and the log to your Google Drive every two minutes, so nothing is lost, and the next run carries on from the last save.

1. Open [script.google.com](https://script.google.com) and click **New project**.
2. Delete what's in the editor and paste everything from [`drive-checkpoint.gs`](drive-checkpoint.gs).
3. Click **Deploy → New deployment**. Under **Select type** (the gear), choose **Web app**.
   - **Execute as:** Me
   - **Who has access:** Anyone
4. Click **Deploy**, then **Authorize access**. Google warns that the app isn't verified: it's your own script, so click **Advanced → Go to … (unsafe)** and **Allow**. It can only create files in one folder, **Stick AI benchmark**, in your Drive.
5. Copy the **Web app URL** (it ends in `/exec`). Treat it like a password and don't post it anywhere.

## 2. Run the notebook

1. On Kaggle: **Create → New Notebook → File → Import Notebook**, and choose `kaggle-max-humaneval.ipynb`.
2. In the right-hand panel, under **Settings**:
   - **Internet:** On
   - **Accelerator:** GPU T4 x2
3. **Add-ons → Secrets → Add a new secret**. Label it `DRIVE_CHECKPOINT_URL`, paste the Web app URL as the value, save, and tick it so this notebook can use it.
4. **Save Version → Save & Run All (Commit)**. You can close the tab.

Follow along in Google Drive: the folder **Stick AI benchmark** gets `run.log` (one line per problem, running score in brackets) and `humaneval-max.json`, updated every two minutes.

## If it stops before the end

Just **Save & Run All** again. It reads the last save from your Drive and carries on with the problems it hasn't done. It always stops itself at 11 hours, before Kaggle's 12-hour limit, so the run's own Output is kept as well.

Free GPU time on Kaggle is about 30 hours a week.
