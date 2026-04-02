imagename="padsi-typescript"
pwd=$(shell pwd)
# if the podman imags is available, use it, otherwise, use the 'just' version installed in the system
opt_podman=$(shell podman image exists $(imagename) && echo "podman run -ti --rm -v \"$(pwd):/code\" --userns=keep-id $(imagename)" || echo "")

branch=padsi48

all: dist

build:
	@echo "Building the extension!"
	git checkout $(branch)
	@$(opt_podman) just build

dist:
	@echo "Building and packing the extension!"
	git checkout $(branch)
	@$(opt_podman) just pack

clean:
	@echo "Cleanups"
	git checkout $(branch)
	@$(opt_podman) just clean
	@rm -rf .npm node_modules
	rm -f padsi@dgac.shell-extension.zip

update:
	@echo "Pulling the extension's new version"
	git checkout main
	git pull
	git checkout $(branch)
	git rebase main

podman-image:
	@echo "Building $(imagename) Podman image"
	podman build -t $(imagename) -f Dockerfile .
