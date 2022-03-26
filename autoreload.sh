#!/bin/bash
export LC_ALL="en_US.UTF-8"

function mk() {
	printf "Generating... "
	rm -r project_out/* || true
	node . project
	echo "Done"
}

mk

inotifywait -q -m -e close_write project/* project/components/* project/pages/* project/static/* |
while read -r filename event; do
	mk
done
