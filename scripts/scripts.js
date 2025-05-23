/* eslint-disable */
import {
  decorateBlock,
  decorateBlocks,
  createOptimizedPicture as libCreateOptimizedPicture,
  decorateButtons,
  decorateIcons,
  decorateSections,
  decorateTemplateAndTheme,
  getMetadata,
  loadBlock,
  loadBlocks,
  loadCSS,
  loadFooter,
  loadHeader,
  loadScript,
  sampleRUM,
  toCamelCase,
  toClassName,
  waitForLCP,
} from './aem.js';
import initializeDropins from './dropins.js';

// Define an execution context
const pluginContext = {
  getAllMetadata,
  getMetadata,
  loadCSS,
  loadScript,
  sampleRUM,
  toCamelCase,
  toClassName,
};

const LCP_BLOCKS = [
  'product-list-page',
  'product-details',
  'commerce-cart',
  'commerce-checkout',
  'commerce-account',
  'commerce-login',
  'adventure-details',
]; // add your LCP blocks to the list


const AUDIENCES = {
  mobile: () => window.innerWidth < 600,
  desktop: () => window.innerWidth >= 600,
  // define your custom audiences here as needed
};

/**
 * Gets all the metadata elements that are in the given scope.
 * @param {String} scope The scope/prefix for the metadata
 * @returns an array of HTMLElement nodes that match the given scope
 */

export function getAllMetadata(scope) {
  return [...document.head.querySelectorAll(`meta[property^="${scope}:"],meta[name^="${scope}-"]`)]
    .reduce((res, meta) => {
      const id = toClassName(meta.name
        ? meta.name.substring(scope.length + 1)
        : meta.getAttribute('property').split(':')[1]);
      res[id] = meta.getAttribute('content');
      return res;
    }, {});
}

window.hlx.plugins.add('experimentation', {
  condition: () => getMetadata('experiment')
    || Object.keys(getAllMetadata('campaign')).length
    || Object.keys(getAllMetadata('audience')).length,
  options: { audiences: AUDIENCES },
  url: '/plugins/experimentation/src/index.js',
});

/**
 * load fonts.css and set a session storage flag
 */
async function loadFonts() {
  await loadCSS(`${window.hlx.codeBasePath}/styles/fonts.css`);
  try {
    if (!window.location.hostname.includes('localhost')) sessionStorage.setItem('fonts-loaded', 'true');
  } catch (e) {
    // do nothing
  }
}

const tabElementMap = {};

function calculateTabSectionCoordinate(main, lastTabBeginningIndex, targetTabSourceSection) {
  if (!tabElementMap[lastTabBeginningIndex]) {
    tabElementMap[lastTabBeginningIndex] = [];
  }
  tabElementMap[lastTabBeginningIndex].push(targetTabSourceSection);
}

function calculateTabSectionCoordinates(main) {
  let lastTabIndex = -1;
  let foldedTabsCounter = 0;
  const mainSections = [...main.childNodes];
  main
    .querySelectorAll('div.section[data-tab-title]')
    .forEach((section) => {
      const currentSectionIndex = mainSections.indexOf(section);

      if (lastTabIndex < 0 || (currentSectionIndex - foldedTabsCounter) !== lastTabIndex) {
        // we construct a new tabs component, at the currentSectionIndex
        lastTabIndex = currentSectionIndex;
        foldedTabsCounter = 0;
      }

      foldedTabsCounter += 2;
      calculateTabSectionCoordinate(main, lastTabIndex, section);
    });
}

async function autoBlockTabComponent(main, targetIndex, tabSections) {
  // the display none will prevent a major CLS penalty.
  // franklin will remove this once the blocks are loaded.
  const section = document.createElement('div');
  section.setAttribute('class', 'section');
  section.setAttribute('style', 'display:none');
  section.dataset.sectionStatus = 'loading';
  const tabsBlock = document.createElement('div');
  tabsBlock.setAttribute('class', 'tabs');

  const tabContentsWrapper = document.createElement('div');
  tabContentsWrapper.setAttribute('class', 'contents-wrapper');

  tabsBlock.appendChild(tabContentsWrapper);

  tabSections.forEach((tabSection) => {
    tabSection.classList.remove('section');
    tabSection.classList.add('contents');
    // remove display: none
    tabContentsWrapper.appendChild(tabSection);
    tabSection.style.display = null;
  });
  main.insertBefore(section, main.childNodes[targetIndex]);
  section.append(tabsBlock);
  decorateBlock(tabsBlock);
  //await loadBlock(tabsBlock);
  // unset display none manually.
  // somehow in some race conditions it won't be picked up by lib-franklin.
  // CLS is not affected
  //section.style.display = null;
}

function aggregateTabSectionsIntoComponents(main) {
  calculateTabSectionCoordinates(main);

  // when we aggregate tab sections into a tab autoblock, the index get's lower.
  // say we have 3 tabs starting at index 10, 12 and 14. and then 3 tabs at 18, 20 and 22.
  // when we fold the first 3 into 1, those will start at index 10. But the other 3 should now
  // start at 6 instead of 18 because 'removed' 2 sections.
  let sectionIndexDelta = 0;
  Object.keys(tabElementMap).map(async (tabComponentIndex) => {
    const tabSections = tabElementMap[tabComponentIndex];
    await autoBlockTabComponent(main, tabComponentIndex - sectionIndexDelta, tabSections);
    sectionIndexDelta = tabSections.length - 1;
  });
}

/**
 * Gets the extension of a URL.
 * @param {string} url The URL
 * @returns {string} The extension
 * @private
 * @example
 * get_url_extension('https://example.com/foo.jpg');
 * // returns 'jpg'
 * get_url_extension('https://example.com/foo.jpg?bar=baz');
 * // returns 'jpg'
 * get_url_extension('https://example.com/foo');
 * // returns ''
 * get_url_extension('https://example.com/foo.jpg#qux');
 * // returns 'jpg'
 */
function getUrlExtension(url) {
  return url.split(/[#?]/)[0].split('.').pop().trim();
}


/**
 * Checks if an element is an external image.
 * @param {Element} element The element
 * @param {string} externalImageMarker The marker for external images
 * @returns {boolean} Whether the element is an external image
 * @private
 */
function isExternalImage(element, externalImageMarker) {
  // if the element is not an anchor, it's not an external image
  if (element.tagName !== 'A') return false;

  // if the element is an anchor with the external image marker as text content,
  // it's an external image
  if (element.textContent.trim() === externalImageMarker) {
    return true;
  }

  // if the element is an anchor with the href as text content and the href has
  // an image extension, it's an external image
  const ext = getUrlExtension(element.getAttribute('href'));
  return (ext && ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext.toLowerCase()));
}


/*
  * Appends query params to a URL
  * @param {string} url The URL to append query params to
  * @param {object} params The query params to append
  * @returns {string} The URL with query params appended
  * @private
  * @example
  * appendQueryParams('https://example.com', { foo: 'bar' });
  * // returns 'https://example.com?foo=bar'
*/
function appendQueryParams(url, params) {
  const { searchParams } = url;
  params.forEach((value, key) => {
    searchParams.set(key, value);
  });
  url.search = searchParams.toString();
  return url.toString();
}


/**
 * Creates an optimized picture element for an image.
 * If the image is not an absolute URL, it will be passed to libCreateOptimizedPicture.
 * @param {string} src The image source URL
 * @param {string} alt The image alt text
 * @param {boolean} eager Whether to load the image eagerly
 * @param {object[]} breakpoints The breakpoints to use
 * @returns {Element} The picture element
 *
 */
export function createOptimizedPicture(src, alt = '', eager = false, breakpoints = [{ media: '(min-width: 600px)', width: '2000' }, { width: '750' }]) {
  const isAbsoluteUrl = /^https?:\/\//i.test(src);


  // Fallback to createOptimizedPicture if src is not an absolute URL
  if (!isAbsoluteUrl) return libCreateOptimizedPicture(src, alt, eager, breakpoints);


  const url = new URL(src);
  const picture = document.createElement('picture');
  const { pathname } = url;
  const ext = pathname.substring(pathname.lastIndexOf('.') + 1);


  // webp
  breakpoints.forEach((br) => {
    const source = document.createElement('source');
    if (br.media) source.setAttribute('media', br.media);
    source.setAttribute('type', 'image/webp');
    const searchParams = new URLSearchParams({ width: br.width, format: 'webply' });
    source.setAttribute('srcset', appendQueryParams(url, searchParams));
    picture.appendChild(source);
  });


  // fallback
  breakpoints.forEach((br, i) => {
    const searchParams = new URLSearchParams({ width: br.width, format: ext });


    if (i < breakpoints.length - 1) {
      const source = document.createElement('source');
      if (br.media) source.setAttribute('media', br.media);
      source.setAttribute('srcset', appendQueryParams(url, searchParams));
      picture.appendChild(source);
    } else {
      const img = document.createElement('img');
      img.setAttribute('loading', eager ? 'eager' : 'lazy');
      img.setAttribute('alt', alt);
      picture.appendChild(img);
      img.setAttribute('src', appendQueryParams(url, searchParams));
    }
  });


  return picture;
}

/**
 * Gets the cleaned up URL removing barriers to get picture src.
 * @param {string} url The URL
 * @returns {string} The normalised url
 * @private
 * @example
 * get_url_extension('https://delivery-p129624-e1269699.adobeaemcloud.com/adobe/assets/urn:aaid:aem:a...492d81/original/as/strawberry.jpg?preferwebp=true');
 * // returns 'https://delivery-p129624-e1269699.adobeaemcloud.com/adobe/assets/urn:aaid:aem:a...492d81/as/strawberry.jpg?preferwebp=true'
 * get_url_extension('https://delivery-p129624-e1269699.adobeaemcloud.com/adobe/assets/urn:aaid:aem:a...492d81/as/strawberry.jpg?accept-experimental=1&preferwebp=true');
 * // returns 'https://delivery-p129624-e1269699.adobeaemcloud.com/adobe/assets/urn:aaid:aem:a...492d81/as/strawberry.jpg?preferwebp=true'
 * get_url_extension('https://delivery-p129624-e1269699.adobeaemcloud.com/adobe/assets/urn:aaid:aem:a...492d81/as/strawberry.jpg?width=2048&height=2048&preferwebp=true');
 * // returns 'https://delivery-p129624-e1269699.adobeaemcloud.com/adobe/assets/urn:aaid:aem:a...492d81/as/strawberry.jpg?preferwebp=true'
 * get_url_extension('https://author-p129624-e1269699.adobeaemcloud.com/adobe/assets/urn:aaid:aem:a...492d81/as/strawberry.jpg?accept-experimental=1&width=2048&height=2048&preferwebp=true');
 * // returns 'https://author-p129624-e1269699.adobeaemcloud.com/adobe/assets/urn:aaid:aem:a...492d81/as/strawberry.jpg?accept-experimental=1&width=2048&height=2048&preferwebp=true'
 */
export function createOptimizedSrc(src) {
  const isDMOpenAPIUrl = /^(https?:\/\/delivery-p[0-9]+-e[0-9-cmstg]+\.adobeaemcloud\.com\/(.*))/gm.test(src);
  const srcUrl = new URL(src);
  if (isDMOpenAPIUrl) {
    srcUrl.searchParams.delete('accept-experimental');
    srcUrl.searchParams.delete('width');
    srcUrl.searchParams.delete('height');
    srcUrl.pathname = srcUrl.pathname.replace('/original/', '/');
  }
  return srcUrl.toString();
}


/*
  * Decorates external images with a picture element
  * @param {Element} ele The element
  * @param {string} deliveryMarker The marker for external images
  * @private
  * @example
  * decorateExternalImages(main, '//External Image//');
  */
function decorateExternalImages(ele, deliveryMarker) {
  const extImages = ele.querySelectorAll('a');
  extImages.forEach((extImage) => {
    if (isExternalImage(extImage, deliveryMarker)) {
      const extImageSrc = createOptimizedSrc(extImage.getAttribute('href'));
      const extPicture = createOptimizedPicture(extImageSrc);

      /* copy query params from link to img */
      const extImageUrl = new URL(extImageSrc);
      const { searchParams } = extImageUrl;
      extPicture.querySelectorAll('source, img').forEach((child) => {
        if (child.tagName === 'SOURCE') {
          const srcset = child.getAttribute('srcset');
          if (srcset) {
              const queryParams = appendQueryParams(new URL(srcset, extImageSrc), searchParams);
              child.setAttribute('srcset', queryParams);  
          }
        } else if (child.tagName === 'IMG') {
          const src = child.getAttribute('src');
          if (src) {
            const queryParams = appendQueryParams(new URL(src, extImageSrc), searchParams);
            child.setAttribute('src', queryParams);
          }
        }
      });
      extImage.parentNode.replaceChild(extPicture, extImage);
    }
  });
}

/**
 * Decorates the main element.
 * @param {Element} main The main element
 */
// eslint-disable-next-line import/prefer-default-export
export function decorateMain(main) {
  // decorate external images with explicit external image marker
  decorateExternalImages(main, '//External Image//');

  // decorate external images with implicit external image marker
  decorateExternalImages(main);
  
  // hopefully forward compatible button decoration
  decorateButtons(main);
  decorateIcons(main);
  decorateSections(main);
  decorateBlocks(main);
}

/**
 * to add/remove a template, just add/remove it in the list below
 */
const TEMPLATE_LIST = [
  'adventures',
];

/**
 * Run template specific decoration code.
 * @param {Element} main The container element
 */
async function decorateTemplates(main) {
  try {
    const template = getMetadata('template');
    const templates = TEMPLATE_LIST;
    if (templates.includes(template)) {
      const mod = await import(`../templates/${template}/${template}.js`);
      loadCSS(`${window.hlx.codeBasePath}/templates/${template}/${template}.css`);
      if (mod.default) {
        await mod.default(main);
      }
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Auto Blocking failed', error);
  }
}


/**
 * Loads everything needed to get to LCP.
 * @param {Element} doc The container element
 */
async function loadEager(doc) {
  document.documentElement.lang = 'en';
  initializeDropins();
  decorateTemplateAndTheme();

  if (getMetadata('breadcrumbs').toLowerCase() === 'true') {
    doc.body.classList.add('has-breadcrumb');
  }

  await window.hlx.plugins.run('loadEager', pluginContext);

  window.adobeDataLayer = window.adobeDataLayer || [];

  let pageType = 'CMS';
  if (document.body.querySelector('main .product-details')) {
    pageType = 'Product';
  } else if (document.body.querySelector('main .product-list-page')) {
    pageType = 'Category';
  } else if (document.body.querySelector('main .commerce-cart')) {
    pageType = 'Cart';
  } else if (document.body.querySelector('main .commerce-checkout')) {
    pageType = 'Checkout';
  }
  window.adobeDataLayer.push({
    pageContext: {
      pageType,
      pageName: document.title,
      eventType: 'visibilityHidden',
      maxXOffset: 0,
      maxYOffset: 0,
      minXOffset: 0,
      minYOffset: 0,
    },
  });

  const main = doc.querySelector('main');
  if (main) {
    decorateMain(main);
    aggregateTabSectionsIntoComponents(main);
    await decorateTemplates(main);
    document.body.classList.add('appear');
    await waitForLCP(LCP_BLOCKS);
  }

  try {
    /* if desktop (proxy for fast connection) or fonts already loaded, load fonts.css */
    if (window.innerWidth >= 900 || sessionStorage.getItem('fonts-loaded')) {
      loadFonts();
    }
  } catch (e) {
    // do nothing
  }
}

/**
 * Loads everything that doesn't need to be delayed.
 * @param {Element} doc The container element
 */
async function loadLazy(doc) {
  const main = doc.querySelector('main');
  await loadBlocks(main);

  const { hash } = window.location;
  const element = hash ? doc.getElementById(hash.substring(1)) : false;
  if (hash && element) element.scrollIntoView();

  loadHeader(doc.querySelector('header'));
  loadFooter(doc.querySelector('footer'));

  loadCSS(`${window.hlx.codeBasePath}/styles/lazy-styles.css`);
  loadFonts();

  sampleRUM('lazy');
  sampleRUM.observe(main.querySelectorAll('div[data-block-name]'));
  sampleRUM.observe(main.querySelectorAll('picture > img'));

  if ((getMetadata('experiment')
    || Object.keys(getAllMetadata('campaign')).length
    || Object.keys(getAllMetadata('audience')).length)) {
    // eslint-disable-next-line import/no-relative-packages
    const { loadLazy: runLazy } = await import('../plugins/experimentation/src/index.js');
    await runLazy(document, { audiences: AUDIENCES }, pluginContext);
  }
}

/**
 * Loads everything that happens a lot later,
 * without impacting the user experience.
 */
function loadDelayed() {
  window.setTimeout(() => {
    window.hlx.plugins.load('delayed', pluginContext);
    window.hlx.plugins.run('loadDelayed', pluginContext);
    // eslint-disable-next-line import/no-cycle
    return import('./delayed.js');
  }, 3000);
  // load anything that can be postponed to the latest here
}

export async function fetchIndex(indexFile, pageSize = 500) {
  const handleIndex = async (offset) => {
    const resp = await fetch(`/${indexFile}.json?limit=${pageSize}&offset=${offset}`);
    const json = await resp.json();

    const newIndex = {
      complete: (json.limit + json.offset) === json.total,
      offset: json.offset + pageSize,
      promise: null,
      data: [...window.index[indexFile].data, ...json.data],
    };

    return newIndex;
  };

  window.index = window.index || {};
  window.index[indexFile] = window.index[indexFile] || {
    data: [],
    offset: 0,
    complete: false,
    promise: null,
  };

  // Return index if already loaded
  if (window.index[indexFile].complete) {
    return window.index[indexFile];
  }

  // Return promise if index is currently loading
  if (window.index[indexFile].promise) {
    return window.index[indexFile].promise;
  }

  window.index[indexFile].promise = handleIndex(window.index[indexFile].offset);
  const newIndex = await (window.index[indexFile].promise);
  window.index[indexFile] = newIndex;

  return newIndex;
}

/**
 * Loads a fragment.
 * @param {string} path The path to the fragment
 * @returns {HTMLElement} The root element of the fragment
 */
export async function loadFragment(path) {
  if (path && path.startsWith('/')) {
    const resp = await fetch(`${path}.plain.html`);
    if (resp.ok) {
      const main = document.createElement('main');
      main.innerHTML = await resp.text();
      decorateMain(main);
      await loadBlocks(main);
      return main;
    }
  }
  return null;
}

export function addElement(type, attributes, values = {}) {
  const element = document.createElement(type);

  Object.keys(attributes).forEach((attribute) => {
    element.setAttribute(attribute, attributes[attribute]);
  });

  Object.keys(values).forEach((val) => {
    element[val] = values[val];
  });

  return element;
}

export function jsx(html, ...args) {
  return html.slice(1).reduce((str, elem, i) => str + args[i] + elem, html[0]);
}

export function createAccordion(header, content, expanded = false) {
  // Create a container for the accordion
  const container = document.createElement('div');
  container.classList.add('accordion');
  const accordionContainer = document.createElement('details');
  accordionContainer.classList.add('accordion-item');

  // Create the accordion header
  const accordionHeader = document.createElement('summary');
  accordionHeader.classList.add('accordion-item-label');
  accordionHeader.innerHTML = `<div>${header}</div>`;

  // Create the accordion content
  const accordionContent = document.createElement('div');
  accordionContent.classList.add('accordion-item-body');
  accordionContent.innerHTML = content;

  accordionContainer.append(accordionHeader, accordionContent);
  container.append(accordionContainer);


  if (expanded) {
    accordionContent.classList.toggle('active');
    accordionHeader.classList.add('open-default');
    accordionContainer.setAttribute('open', true);
  }

  function updateContent(newContent) {
    accordionContent.innerHTML = newContent;
  }

  return [container, updateContent];
}

export function generateListHTML(data) {
  let html = '<ul>';
  data.forEach(item => {
      html += `<li>${item.label}: <span>${item.value}</span></li>`;
  });
  html += '</ul>';
  return html;
}

export function getBlockPlaceholderInfo(block) {
  const object = {};
  let currentKey = null;

  block.childNodes.forEach((child) => {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const key = child.querySelector('strong');
      if (key) {
        currentKey = key.textContent.trim();
        object[currentKey] = {};
      } else if (currentKey) {
        const divs = child.querySelectorAll('div');
        if (divs.length === 2) {
          const [keyDiv, valueDiv] = divs;
          const keyValue = keyDiv.textContent.trim();
          const value = valueDiv.textContent.trim();
          object[currentKey][keyValue] = value;
        }
      }
    }
  });

  return object;
}

export function buildAdventureBreadcrumbs() {
  const path = window.location.pathname.split('/').slice(1).map((word) => word.charAt(0).toUpperCase() + word.slice(1).replace(/-/g, ' '));
  const breadcrumbContainer = document.createElement('div');
  breadcrumbContainer.className = 'breadcrumb-wrapper';

  const adventuresLink = document.createElement('a');
  adventuresLink.href = '/adventures';
  adventuresLink.textContent = 'Adventures';
  breadcrumbContainer.appendChild(adventuresLink);

  if (path.length > 2) {
    breadcrumbContainer.appendChild(document.createTextNode(' • '));
    const adventureName = document.createElement('span');
    adventureName.textContent = path[path.length - 2];
    breadcrumbContainer.appendChild(adventureName);
  } else if (path.length === 2) {
    breadcrumbContainer.appendChild(document.createTextNode(' • '));
    const adventureName = document.createElement('span');
    adventureName.textContent = path[1];
    breadcrumbContainer.appendChild(adventureName);
  }

  const firstSection = document.querySelector('main > .section');
  firstSection.prepend(breadcrumbContainer);
  firstSection.classList.add('breadcrumb-container');
}

async function loadPage() {
  await window.hlx.plugins.load('eager', pluginContext);
  await loadEager(document);
  await window.hlx.plugins.load('lazy', pluginContext);
  await loadLazy(document);
  loadDelayed();
}

loadPage();
