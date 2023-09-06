import { Page } from 'puppeteer-core'
import WorkerPool from 'workerpool'
import { SERVER_LESS, resourceExtension, userDataPath } from '../../constants'
import Console from '../../utils/ConsoleHandler'
import {
	BANDWIDTH_LEVEL,
	BANDWIDTH_LEVEL_LIST,
	CACHEABLE_STATUS_CODE,
	DURATION_TIMEOUT,
	MAX_WORKERS,
	POWER_LEVEL,
	POWER_LEVEL_LIST,
	regexNotFoundPageID,
	regexQueryStringSpecialInfo,
} from '../constants'
import { ENV } from '../../constants'
import { ISSRResult } from '../types'
import BrowserManager from './BrowserManager'
import CacheManager from './CacheManager'

const browserManager = (() => {
	if (POWER_LEVEL === POWER_LEVEL_LIST.THREE)
		return BrowserManager(() => `${userDataPath}/user_data_${Date.now()}`)
	return BrowserManager()
})()

interface ISSRHandlerParam {
	startGenerating: number
	isFirstRequest: boolean
	url: string
}

const getRestOfDuration = (startGenerating, gapDuration = 0) => {
	if (!startGenerating) return 0

	return DURATION_TIMEOUT - gapDuration - (Date.now() - startGenerating)
} // getRestOfDuration

const waitResponse = async (page: Page, url: string, duration: number) => {
	const timeoutDuration = (() => {
		const maxDuration =
			BANDWIDTH_LEVEL === BANDWIDTH_LEVEL_LIST.TWO ? 3000 : DURATION_TIMEOUT

		return duration > maxDuration ? maxDuration : duration
	})()
	const startWaiting = new Date().getMilliseconds()
	let response
	let isError = false
	try {
		response = await page.goto(url, {
			waitUntil: 'networkidle2',
			timeout: timeoutDuration,
		})
	} catch (err) {
		isError = true
		throw err
	} finally {
		if (isError) return response
	}

	const waitingDuration = new Date().getMilliseconds() - startWaiting
	const restOfDuration = timeoutDuration - waitingDuration

	if (restOfDuration <= 0) return response

	await new Promise((res) => {
		let duration = ENV === 'development' ? 1500 : 250
		const maxLimitTimeout = restOfDuration > 3000 ? 3000 : restOfDuration
		let limitTimeout = setTimeout(
			() => {
				if (responseTimeout) clearTimeout(responseTimeout)
				res(undefined)
			},
			restOfDuration > maxLimitTimeout ? maxLimitTimeout : restOfDuration
		)
		let responseTimeout: NodeJS.Timeout
		const handleTimeout = () => {
			if (responseTimeout) clearTimeout(responseTimeout)
			responseTimeout = setTimeout(() => {
				if (limitTimeout) clearTimeout(limitTimeout)
				res(undefined)
			}, duration)

			duration = ENV === 'development' ? 500 : 150
		}

		handleTimeout()

		page.on('requestfinished', () => {
			handleTimeout()
		})
		page.on('requestservedfromcache', () => {
			handleTimeout()
		})
		page.on('requestfailed', () => {
			handleTimeout()
		})
	})

	return response
} // waitResponse

const gapDurationDefault = 1500

const SSRHandler = async ({ isFirstRequest, url }: ISSRHandlerParam) => {
	const startGenerating = Date.now()
	if (getRestOfDuration(startGenerating, gapDurationDefault) <= 0) return

	const cacheManager = CacheManager()

	Console.log('Bắt đầu tạo page mới')

	const page = await browserManager.newPage()

	let restOfDuration = getRestOfDuration(startGenerating, gapDurationDefault)

	if (!page || restOfDuration <= 0) {
		if (!page && !isFirstRequest) {
			const tmpResult = await cacheManager.achieve(url)

			return tmpResult
		}
		return
	}

	Console.log('Số giây còn lại là: ', restOfDuration / 1000)
	Console.log('Tạo page mới thành công')

	let html = ''
	let status = 200
	let isGetHtmlProcessError = false

	try {
		// await page.waitForNetworkIdle({ idleTime: 250 })
		await page.setRequestInterception(true)
		page.on('request', (req) => {
			const resourceType = req.resourceType()

			if (resourceType === 'stylesheet') {
				req.respond({ status: 200, body: 'aborted' })
			} else if (
				/(socket.io.min.js)+(?:$)|data:image\/[a-z]*.?\;base64/.test(url) ||
				/font|image|media|imageset/.test(resourceType)
			) {
				req.abort()
			} else {
				req.continue()
			}
		})

		const specialInfo = regexQueryStringSpecialInfo.exec(url)?.groups ?? {}

		await page.setExtraHTTPHeaders({
			...specialInfo,
			service: 'puppeteer',
		})

		await new Promise(async (res) => {
			Console.log(`Bắt đầu crawl url: ${url}`)

			let response

			try {
				response = await waitResponse(page, url, restOfDuration)
			} catch (err) {
				if (err.name !== 'TimeoutError') {
					isGetHtmlProcessError = true
					res(false)
					return Console.error(err)
				}
			} finally {
				status = response?.status?.() ?? status
				Console.log('Crawl thành công!')
				Console.log(`Response status là: ${status}`)

				res(true)
			}
		})
	} catch (err) {
		Console.log('Page mới đã bị lỗi')
		Console.error(err)
		return
	}

	if (isGetHtmlProcessError) return

	let result: ISSRResult
	try {
		html = await page.content() // serialized HTML of page DOM.
		await page.close()
	} catch (err) {
		Console.error(err)
		return
	} finally {
		status = html && regexNotFoundPageID.test(html) ? 404 : 200
		if (CACHEABLE_STATUS_CODE[status]) {
			result = await cacheManager.set({
				html,
				url,
				isRaw: true,
			})
		} else {
			await cacheManager.remove(url)
			return {
				status,
				html,
			}
		}
	}

	restOfDuration = getRestOfDuration(startGenerating)

	return result
	// Console.log('Bắt đầu optimize nội dung file')

	// const optimizeHTMLContentPool = WorkerPool.pool(
	// 	__dirname + `/OptimizeHtml.worker.${resourceExtension}`,
	// 	{
	// 		minWorkers: 1,
	// 		maxWorkers: MAX_WORKERS,
	// 	}
	// )

	// try {
	// 	html = await optimizeHTMLContentPool.exec('compressContent', [html])
	// 	html = await optimizeHTMLContentPool.exec('optimizeContent', [html, true])
	// } catch (err) {
	// 	Console.error(err)
	// 	return
	// } finally {
	// 	optimizeHTMLContentPool.terminate()

	// 	result = await cacheManager.set({
	// 		html,
	// 		url,
	// 		isRaw: false,
	// 	})

	// 	return result
	// }
}

export default SSRHandler