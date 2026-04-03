imagename="padsi-typescript"
pwd=$(shell pwd)
# if the podman imags is available, use it, otherwise, use the 'just' version installed in the system
opt_podman=$(shell podman image exists $(imagename) && echo "podman run -ti --rm -v \"$(pwd):/code\" --userns=keep-id $(imagename)" || echo "")

all: dist

build:
	@echo "Building the extension!"
	@$(opt_podman) just build

dist:
	@echo "Building and packing the extension!"
	@$(opt_podman) just pack

clean:
	@echo "Cleanups"
	@$(opt_podman) just clean
	@rm -rf .npm node_modules
	rm -f padsi@dgac.shell-extension.zip

update:
	@echo "Pulling the extension's new version"
	git checkout main
	git pull
	git rebase main

podman-image:
	@echo "Building $(imagename) Podman image"
	podman build -t $(imagename) -f Dockerfile .
