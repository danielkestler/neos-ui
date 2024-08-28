import {put, select, takeEvery} from 'redux-saga/effects';

import {actions, actionTypes, selectors} from '@neos-project/neos-ui-redux-store';
import {requestIdleCallback} from '@neos-project/utils-helpers';

import initializeContentDomNode from './initializeContentDomNode';
import {
    dispatchCustomEvent,
    findAllNodesInGuestFrame,
    findInGuestFrame,
    findNodeInGuestFrame,
    getGuestFrameDocument,
    getGuestFrameWindow
} from './dom';

import style from './style.module.css';
import {SelectionModeTypes} from '@neos-project/neos-ts-interfaces';
import backend from '@neos-project/neos-ui-backend-connector';

//
// Get all parent elements of the event target.
//
// It's not possible to use `event.composedPath()` here because
// it doesn't work in FF with past events stored in a closure.
//
const eventPath = event => {
    let element = event.target;
    const path = [];

    while (element) {
        path.push(element);
        if (element.tagName === 'HTML') {
            path.push(document);
            path.push(window);
            return path;
        }
        element = element.parentElement;
    }
    return path;
};

export default ({globalRegistry, store}) => function * initializeGuestFrame() {
    const nodeTypesRegistry = globalRegistry.get('@neos-project/neos-ui-contentrepository');
    const inlineEditorRegistry = globalRegistry.get('inlineEditors');
    const guestFrameWindow = getGuestFrameWindow();
    const documentInformation = Object.assign({}, guestFrameWindow['@Neos.Neos.Ui:DocumentInformation']);

    // The user may have navigated by clicking an inline link - that's why we need to update the contentCanvas URL to be in sync with the shown content.
    // We need to set the src to the actual src of the iframe, and not retrive it from documentInformation, as it may differ, e.g. contain additional arguments.
    yield put(actions.UI.ContentCanvas.setSrc(guestFrameWindow.document.location.href));

    // If we have no document information, guest frame intialziation ends here
    if (Object.entries(documentInformation).length === 0) {
        return;
    }

    // If we don't have access to the document due to a NodeTreePrivilege, the serialized document
    // information is going to be null. In that case, we stop initializing the guest frame.
    if (documentInformation.metaData.documentNodeSerialization === null) {
        return;
    }

    // Load legacy node data scripts from guest frame - remove with Neos 9.0
    const legacyNodeData = guestFrameWindow['@Neos.Neos.Ui:Nodes'] || {};

    // Load all nodedata for nodes in the guest frame and filter duplicates
    const {q} = yield backend.get();
    const nodeContextPathsInGuestFrame = findAllNodesInGuestFrame().map(node => node.getAttribute('data-__neos-node-contextpath'));

    // Filter nodes that are already present in the redux store and duplicates
    const nodesByContextPath = store.getState().cr.nodes.byContextPath;
    const notFullyLoadedNodeContextPaths = [...new Set(nodeContextPathsInGuestFrame)].filter((contextPath) => {
        const node = nodesByContextPath[contextPath];
        const nodeIsLoaded = node !== undefined && node.isFullyLoaded;
        return !nodeIsLoaded;
    });

    // Load remaining list of not fully loaded nodes from the backend if there are any
    const fullyLoadedNodesFromContent = notFullyLoadedNodeContextPaths.length > 0 ? (yield q(notFullyLoadedNodeContextPaths).get()).reduce((nodes, node) => {
        nodes[node.contextPath] = node;
        return nodes;
    }, {}) : {};

    const nodes = Object.assign(
        {},
        legacyNodeData, // Merge legacy node data from the guest frame - remove with Neos 9.0
        fullyLoadedNodesFromContent,
        {
            [documentInformation.metaData.documentNode]: documentInformation.metaData.documentNodeSerialization
        }
    );

    // Merge new nodes into the store
    yield put(actions.CR.Nodes.merge(nodes));

    // Remove the legacy inline scripts after initialization - remove with Neos 9.0
    Array.prototype.forEach.call(guestFrameWindow.document.querySelectorAll('script[data-neos-nodedata]'), element => element.parentElement.removeChild(element));

    const state = store.getState();

    // Set the current document node to the one that is rendered in the guest frame which might be different from the one that is currently selected in the page tree
    const currentDocumentNodeContextPath = yield select(
        state => state?.cr?.nodes?.documentNode
    );
    if (currentDocumentNodeContextPath !== documentInformation.metaData.documentNode) {
        yield put(actions.CR.Nodes.setDocumentNode(documentInformation.metaData.documentNode, documentInformation.metaData.siteNode));
    }
    yield put(actions.UI.ContentCanvas.setPreviewUrl(documentInformation.metaData.previewUrl));
    yield put(actions.CR.ContentDimensions.setActive(documentInformation.metaData.contentDimensions.active));
    // The user may have navigated by clicking an inline link - that's why we need to update the contentCanvas URL to be in sync with the shown content.
    // We need to set the src to the actual src of the iframe, and not retrieve it from documentInformation, as it may differ, e.g. contain additional arguments.
    yield put(actions.UI.ContentCanvas.setSrc(guestFrameWindow.document.location.href));

    const editPreviewMode = state?.ui?.editPreviewMode;
    const editPreviewModes = globalRegistry.get('frontendConfiguration').get('editPreviewModes');
    const isWorkspaceReadOnly = selectors.CR.Workspaces.isWorkspaceReadOnlySelector(state);
    const currentEditMode = editPreviewModes[editPreviewMode];
    if (!currentEditMode || !currentEditMode.isEditingMode || isWorkspaceReadOnly) {
        return;
    }

    const focusSelectedNode = event => {
        const clickPath = Array.prototype.slice.call(eventPath(event));
        const isInsideInlineUi = clickPath.some(domNode =>
            domNode &&
            domNode.getAttribute &&
            domNode.getAttribute('data-__neos__inline-ui')
        );
        const isInsideEditableProperty = clickPath.some(domNode =>
            domNode &&
            domNode.getAttribute &&
            domNode.getAttribute('data-__neos-property')
        );
        const selectedDomNode = clickPath.find(domNode =>
            domNode &&
            domNode.getAttribute &&
            domNode.getAttribute('data-__neos-node-contextpath')
        );

        if (isInsideInlineUi) {
            // Do nothing, everything OK!
        } else if (selectedDomNode) {
            const contextPath = selectedDomNode.getAttribute('data-__neos-node-contextpath');
            const fusionPath = selectedDomNode.getAttribute('data-__neos-fusion-path');
            const state = store.getState();
            const focusedNodeContextPath = selectors.CR.Nodes.focusedNodePathSelector(state);
            if (!isInsideEditableProperty) {
                store.dispatch(actions.UI.ContentCanvas.setCurrentlyEditedPropertyName(''));
            }
            if (!isInsideEditableProperty || focusedNodeContextPath !== contextPath) {
                store.dispatch(actions.CR.Nodes.focus(contextPath, fusionPath));
            }
        } else {
            store.dispatch(actions.UI.ContentCanvas.setCurrentlyEditedPropertyName(''));
            store.dispatch(actions.CR.Nodes.unFocus());
        }
    };

    // We store the original mousedown event in order to prevent bugs like this: https://github.com/neos/neos-ui/issues/1934
    let mouseDownEvent = null;
    getGuestFrameDocument().addEventListener('mousedown', event => {
        mouseDownEvent = event;
    });
    getGuestFrameDocument().addEventListener('mouseup', () => {
        if (mouseDownEvent) {
            focusSelectedNode(mouseDownEvent);
        }
        mouseDownEvent = null;
    });

    getGuestFrameDocument().addEventListener('keyup', e => {
        if (e.key === 'Tab') {
            focusSelectedNode(e);
        }
    });

    const initializeNodes = findAllNodesInGuestFrame().reduceRight((initializeSubSequentNodes, node) => () => {
        const initializeCurrentNode = initializeContentDomNode({
            store,
            globalRegistry,
            nodeTypesRegistry,
            inlineEditorRegistry
        });

        requestIdleCallback(() => {
            // Only of guest frame document did not change in the meantime, we continue initializing the node
            if (getGuestFrameDocument() === node.ownerDocument) {
                initializeCurrentNode(node);
            }
            initializeSubSequentNodes();
        });
    }, () => { /* This noop function is called right at the end of content inialization */ });

    initializeNodes();

    // When the contentCanvas is reloaded (e.g. from the inspector change) and focused style to it
    const focusedNode = yield select(selectors.CR.Nodes.focusedNodePathSelector);
    const focusedNodeElement = findNodeInGuestFrame(focusedNode);
    if (focusedNodeElement) {
        focusedNodeElement.classList.add(style['markActiveNodeAsFocused--focusedNode']);
        // Request to scroll focused node into view
        yield put(actions.UI.ContentCanvas.requestScrollIntoView(true));
    }

    yield takeEvery(actionTypes.CR.Nodes.FOCUS, function * (action) {
        // Don't focus node in contentcanvas when multiselecting
        if (action.payload.selectionMode !== SelectionModeTypes.SINGLE_SELECT) {
            return;
        }
        const oldNode = findInGuestFrame(`.${style['markActiveNodeAsFocused--focusedNode']}`);

        if (oldNode) {
            oldNode.classList.remove(style['markActiveNodeAsFocused--focusedNode']);
        }

        const {contextPath, fusionPath} = action.payload;

        if (contextPath) {
            const nodeElement = findNodeInGuestFrame(contextPath, fusionPath);

            if (nodeElement) {
                nodeElement.classList.add(style['markActiveNodeAsFocused--focusedNode']);

                const getNodeByContextPathSelector = selectors.CR.Nodes.makeGetNodeByContextPathSelector(contextPath);
                const node = yield select(getNodeByContextPathSelector);
                dispatchCustomEvent('Neos.NodeSelected', 'Node was selected.', {
                    element: nodeElement,
                    node
                });
            }
        }
    });

    yield takeEvery(actionTypes.CR.Nodes.UNFOCUS, () => {
        const node = findInGuestFrame(`.${style['markActiveNodeAsFocused--focusedNode']}`);

        if (node) {
            node.classList.remove(style['markActiveNodeAsFocused--focusedNode']);
        }
    });
};
