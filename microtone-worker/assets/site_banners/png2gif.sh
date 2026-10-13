#!/usr/bin/bash
filename="$1"
ffmpeg -i $filename -vf "split[v],palettegen,[v]paletteuse" ${filename%.*}.gif
