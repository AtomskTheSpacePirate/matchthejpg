# Builds match-pixel-colors/palettes.json: each photo's main colours, for the Match Pixel Colors game.
# Run again whenever photos are added to or removed from pixel-photos-web (after
# make-web-photos.ps1):
#   powershell -ExecutionPolicy Bypass -File match-pixel-colors\tools\build-palettes.ps1
#
# Each photo is shrunk to a small copy (so a "pixel" is the colour of a tiny area, not a noisy
# dot) and its colours are grouped into CLUSTERS main colours. For each colour the file keeps
# its OKLab value, how much of the photo it covers, and a few real pixels of it with their
# position, so the game can show where they came from. Results are the same on every run.

$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot)
$photos = Join-Path $root 'pixel-photos-web'
$out = Join-Path $root 'match-pixel-colors\palettes.json'

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Text;

public static class Palette {
  const int SIZE = 48;        // long edge of the small copy, in pixels
  const int CLUSTERS = 8;     // main colours per photo
  const int SAMPLES = 3;      // real pixels kept per colour
  const int ROUNDS = 15;      // k-means passes

  static double Linear(double c) {
    c /= 255.0;
    return c <= 0.04045 ? c / 12.92 : Math.Pow((c + 0.055) / 1.055, 2.4);
  }

  static double[] Lab(Color p) {
    double r = Linear(p.R), g = Linear(p.G), b = Linear(p.B);
    double l = Math.Pow(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 1.0 / 3);
    double m = Math.Pow(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b, 1.0 / 3);
    double s = Math.Pow(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b, 1.0 / 3);
    return new[] {
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s };
  }

  static double Dist2(double[] x, double[] y) {
    double a = x[0] - y[0], b = x[1] - y[1], c = x[2] - y[2];
    return a * a + b * b + c * c;
  }

  static string N(double v) { return v.ToString("0.####", CultureInfo.InvariantCulture); }

  // JSON for one photo: an array of colours, biggest first.
  public static string Build(string path, string name) {
    int w, h;
    Color[] px;
    using (var src = new Bitmap(path)) {
      double scale = (double)SIZE / Math.Max(src.Width, src.Height);
      w = Math.Max(1, (int)Math.Round(src.Width * scale));
      h = Math.Max(1, (int)Math.Round(src.Height * scale));
      using (var small = new Bitmap(w, h))
      using (var g = Graphics.FromImage(small)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.DrawImage(src, 0, 0, w, h);
        px = new Color[w * h];
        for (int y = 0; y < h; y++)
          for (int x = 0; x < w; x++) px[y * w + x] = small.GetPixel(x, y);
      }
    }
    int n = px.Length;
    var lab = new double[n][];
    for (int i = 0; i < n; i++) lab[i] = Lab(px[i]);

    // k-means++ start, seeded by the file name so every run gives the same colours.
    var rnd = new Random(name.GetHashCode() & 0x7fffffff);
    var centres = new List<double[]>();
    centres.Add((double[])lab[rnd.Next(n)].Clone());
    var d2 = new double[n];
    while (centres.Count < CLUSTERS) {
      double total = 0;
      for (int i = 0; i < n; i++) {
        double best = double.MaxValue;
        foreach (var c in centres) best = Math.Min(best, Dist2(lab[i], c));
        d2[i] = best;
        total += best;
      }
      if (total <= 0) break;
      double pick = rnd.NextDouble() * total;
      int k = 0;
      for (; k < n - 1; k++) { pick -= d2[k]; if (pick <= 0) break; }
      centres.Add((double[])lab[k].Clone());
    }

    var group = new int[n];
    for (int round = 0; round < ROUNDS; round++) {
      for (int i = 0; i < n; i++) {
        double best = double.MaxValue;
        for (int c = 0; c < centres.Count; c++) {
          double d = Dist2(lab[i], centres[c]);
          if (d < best) { best = d; group[i] = c; }
        }
      }
      for (int c = 0; c < centres.Count; c++) {
        double L = 0, A = 0, B = 0; int count = 0;
        for (int i = 0; i < n; i++) if (group[i] == c) { L += lab[i][0]; A += lab[i][1]; B += lab[i][2]; count++; }
        if (count > 0) centres[c] = new[] { L / count, A / count, B / count };
      }
    }

    // Per colour: its share of the photo and SAMPLES real pixels from the half of its members
    // closest to its centre, spread out over that half.
    var colours = new List<KeyValuePair<double, string>>();
    for (int c = 0; c < centres.Count; c++) {
      var members = new List<int>();
      for (int i = 0; i < n; i++) if (group[i] == c) members.Add(i);
      if (members.Count == 0) continue;
      var centre = centres[c];
      members.Sort((a, b) => Dist2(lab[a], centre).CompareTo(Dist2(lab[b], centre)));
      int close = Math.Max(1, members.Count / 2);
      var samples = new StringBuilder();
      int take = Math.Min(SAMPLES, close);
      for (int s = 0; s < take; s++) {
        int i = members[s * close / take];
        var p = px[i];
        if (s > 0) samples.Append(',');
        samples.AppendFormat("{{\"hex\":\"#{0:x2}{1:x2}{2:x2}\",\"x\":{3},\"y\":{4}}}",
          p.R, p.G, p.B, N((i % w + 0.5) / w), N((i / w + 0.5) / h));
      }
      double share = (double)members.Count / n;
      colours.Add(new KeyValuePair<double, string>(share, string.Format(
        "{{\"lab\":[{0},{1},{2}],\"share\":{3},\"samples\":[{4}]}}",
        N(centre[0]), N(centre[1]), N(centre[2]), N(share), samples)));
    }
    colours.Sort((a, b) => b.Key.CompareTo(a.Key));
    var json = new StringBuilder("[");
    for (int c = 0; c < colours.Count; c++) { if (c > 0) json.Append(','); json.Append(colours[c].Value); }
    return json.Append(']').ToString();
  }
}
'@

$files = Get-ChildItem -LiteralPath $photos -File |
  Where-Object { @('.jpg', '.jpeg', '.png') -contains $_.Extension.ToLower() } |
  Sort-Object Name
$entries = foreach ($f in $files) {
  Write-Host "  $($f.Name)"
  '"' + $f.Name + '":' + [Palette]::Build($f.FullName, $f.Name)
}
$json = "{`n" + ($entries -join ",`n") + "`n}`n"
[IO.File]::WriteAllText($out, $json, (New-Object Text.UTF8Encoding $false))
Write-Host "Wrote $($files.Count) photos to $out"
